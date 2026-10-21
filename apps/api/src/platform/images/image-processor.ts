import { detectContentType } from '@nestjs/storage';
import type { Metadata, Sharp } from 'sharp';
import {
  isProcessable,
  RENDITION_CONTENT_TYPE,
  RENDITION_NAMES,
  RENDITION_SPECS,
  type RenditionName,
} from './renditions.js';

/**
 * Why an image was refused. All of them are about this input, so trying
 * again changes nothing: the attachment keeps the file as uploaded.
 * - `pixels`: more than IMAGE_MAX_PIXELS in one frame (a decompression
 *   bomb: a small file that inflates to gigabytes).
 * - `size`: a file larger than the worker will load (`MAX_INPUT_BYTES`), or
 *   one whose copy without metadata would be much larger than it
 *   (`MAX_GROWTH`).
 * - `format`: not JPEG, PNG, WebP or GIF, whatever it was called.
 * - `timeout`: a conversion over IMAGE_TIMEOUT_MS.
 * - `invalid`: damaged or truncated (the library refuses it, with its
 *   strictest `failOn`, the default).
 */
export type ImageRejection =
  'pixels' | 'size' | 'format' | 'timeout' | 'invalid';

export class ImageRejectedError extends Error {
  constructor(
    readonly reason: ImageRejection,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ImageRejectedError';
  }
}

export interface ImageProcessorOptions {
  /** Pixels of one frame (width × height) an input may have; more is refused before any is decoded. */
  maxPixels: number;
  /** How long one conversion may run, in milliseconds. */
  timeoutMs: number;
  /** Re-encode an original that carries metadata (EXIF, GPS, XMP…) without it. */
  stripOriginals: boolean;
}

/** The most a worker loads into memory for one image; ATTACHMENT_MAX_MB may be larger. */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

/** Bytes the storage package needs to recognize an image's signature. */
const SNIFF_BYTES = 16;

/** Quality of a re-encoded JPEG or lossy WebP original: high, so that the loss is not visible. */
const ORIGINAL_QUALITY = 90;

/**
 * How much larger than the original its copy without metadata may be: four
 * times, plus 64 KiB for a tiny file. Re-encoding grows a heavily compressed
 * original somewhat (measured: a JPEG of quality 10 written at 90, three
 * times; a 1-bit PNG written with 8 bits, three and a half), but a PNG can be
 * built to compress well only as it was uploaded (each row the one above
 * plus a step its encoder's filters do not try): 10 KB that come out 2 MB,
 * stored in place of the upload past what its size and the quota let in.
 * Larger is refused (`size`), the original left as uploaded.
 */
const MAX_GROWTH = 4;
const GROWTH_ALLOWANCE = 64 * 1024;

export interface ProcessedRendition {
  data: Buffer;
  /** Pixels, upright. */
  width: number;
  height: number;
  contentType: typeof RENDITION_CONTENT_TYPE;
}

export interface ProcessedImage {
  renditions: Record<RenditionName, ProcessedRendition>;
  /**
   * The original without its metadata, same format and orientation baked
   * in. Only when it had metadata, stripping is on and re-encoding it is
   * sound (a JPEG, PNG or WebP of one frame and 8 bits per channel); else
   * the original stays byte for byte as uploaded. At most `MAX_GROWTH`
   * times the original's size.
   */
  stripped?: { data: Buffer; removed: string[] };
}

type SharpFactory = (typeof import('sharp'))['default'];

/** The formats the library may report for an input we process. */
const FORMATS: ReadonlySet<string> = new Set(['jpeg', 'png', 'webp', 'gif']);
/** Of those, the ones whose metadata we remove (a GIF has no EXIF to leak). */
const STRIPPABLE: ReadonlySet<string> = new Set(['jpeg', 'png', 'webp']);
/** The kinds of metadata, in the order they are reported (`stripped.removed`). */
const KINDS = ['exif', 'xmp', 'iptc', 'photoshop', 'comments'] as const;

/**
 * Makes the renditions of an image and strips its metadata, with sharp
 * (libvips): `process()` takes the file's bytes and gives back the bytes of
 * the files to store. It knows nothing of attachments, tenants or storage
 * (the job in platform/attachments does), so the avatar could use it as it
 * is.
 *
 * Untrusted input, so: the pixel count is checked from the header before
 * a pixel is decoded (`limitInputPixels`: a 50 KB PNG may claim 400
 * megapixels), the library's strictest `failOn` (the default: a damaged
 * file is refused, not repaired), one frame of an animation, a time limit
 * per conversion, and only JPEG, PNG, WebP and GIF. sharp is loaded on the
 * first image, not at boot: a process that only queues jobs (the API) never
 * loads libvips, and a platform without its prebuilt binary fails a job,
 * not the application.
 */
export class ImageProcessor {
  private loaded: Promise<SharpFactory> | undefined;

  constructor(private readonly options: ImageProcessorOptions) {}

  /** Largest file `process()` takes, in bytes. */
  readonly maxBytes = MAX_INPUT_BYTES;

  async process(input: Buffer): Promise<ProcessedImage> {
    if (input.length > MAX_INPUT_BYTES) {
      throw new ImageRejectedError(
        'size',
        `The image is ${input.length} bytes; at most ${MAX_INPUT_BYTES} are processed.`,
      );
    }
    // By the bytes, before any decoder sees them: libvips would also open an
    // SVG, a TIFF or a PDF, which uploads are not here to be (the storage
    // package's signatures know JPEG, PNG, GIF and WebP, and AVIF and HEIC).
    const detected = detectContentType(input.subarray(0, SNIFF_BYTES));
    if (!detected || !isProcessable(detected)) {
      throw new ImageRejectedError(
        'format',
        `Not an image that is processed: ${detected ?? 'unknown'}.`,
      );
    }
    const sharp = await this.sharp();
    const open = (): Sharp =>
      sharp(input, {
        limitInputPixels: this.options.maxPixels,
        failOn: 'warning',
      }).timeout({
        seconds: Math.max(1, Math.ceil(this.options.timeoutMs / 1000)),
      });

    const meta = await attempt(() => open().metadata());
    if (!meta.format || !FORMATS.has(meta.format)) {
      throw new ImageRejectedError(
        'format',
        `Not an image that is processed: ${meta.format ?? 'unknown'}.`,
      );
    }

    // One at a time: each conversion decodes the image again, but none holds
    // more than the one it is working on (a 48 MP photo peaks near 150 MB).
    const renditions = {} as Record<RenditionName, ProcessedRendition>;
    for (const name of RENDITION_NAMES) {
      const { px, quality } = RENDITION_SPECS[name];
      const { data, info } = await attempt(() =>
        open()
          .autoOrient()
          .resize({
            width: px,
            height: px,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality })
          .toBuffer({ resolveWithObject: true }),
      );
      renditions[name] = {
        data,
        width: info.width,
        height: info.height,
        contentType: RENDITION_CONTENT_TYPE,
      };
    }

    const found = new Set(metadataKinds(meta));
    let animated = false;
    if (meta.format === 'png') {
      const png = scanPng(input);
      for (const kind of png.kinds) found.add(kind);
      animated = png.animated;
    }
    const removed = KINDS.filter((kind) => found.has(kind));
    if (
      !this.options.stripOriginals ||
      removed.length === 0 ||
      !STRIPPABLE.has(meta.format) ||
      (meta.pages ?? 1) > 1 ||
      // An APNG reports one page (the library loads only its default image):
      // a re-encoded copy would be a still, and replace the animation.
      animated ||
      // 16-bit images would come out 8-bit: leave them (and their metadata) alone.
      (meta.depth !== undefined && meta.depth !== 'uchar')
    ) {
      return { renditions };
    }
    // Same format, rotated upright (the Orientation tag goes with the rest of
    // the EXIF, so the pixels must carry it), colours in sRGB (the library's
    // default; the ICC profile goes too). A lossless original stays lossless.
    let pipeline = open().autoOrient();
    if (meta.format === 'jpeg') {
      pipeline = pipeline.jpeg({ quality: ORIGINAL_QUALITY });
    } else if (meta.format === 'webp') {
      pipeline = pipeline.webp(
        isLosslessWebp(input)
          ? { lossless: true }
          : { quality: ORIGINAL_QUALITY },
      );
    } else {
      // Row filters chosen per row, as most encoders do: without them (the
      // library's default) a PNG comes out several times larger.
      pipeline = pipeline.png({
        palette: meta.isPalette === true,
        adaptiveFiltering: true,
      });
    }
    const data = await attempt(() => pipeline.toBuffer());
    const most = input.length * MAX_GROWTH + GROWTH_ALLOWANCE;
    if (data.length > most) {
      throw new ImageRejectedError(
        'size',
        `Without its metadata the image would be ${data.length} bytes, more than ${MAX_GROWTH} times its ${input.length}.`,
      );
    }
    return { renditions, stripped: { data, removed } };
  }

  private sharp(): Promise<SharpFactory> {
    this.loaded ??= import('sharp').then((module) => {
      const sharp = module.default;
      // Every image is processed once: a cache only holds on to memory.
      sharp.cache(false);
      return sharp;
    });
    return this.loaded;
  }
}

/** The kinds of metadata an image carries that name its maker, device, place or editor. */
export function metadataKinds(meta: Metadata): string[] {
  const kinds: string[] = [];
  if (meta.exif) kinds.push('exif');
  if (meta.xmp) kinds.push('xmp');
  if (meta.iptc) kinds.push('iptc');
  if (meta.tifftagPhotoshop) kinds.push('photoshop');
  if (meta.comments?.length) kinds.push('comments');
  return kinds;
}

/** The keyword (and its terminating NUL) of the iTXt chunk that holds a PNG's XMP. */
const XMP_KEYWORD = 'XML:com.adobe.xmp\0';

/**
 * What the chunks of a PNG say that the library does not: the kinds of
 * metadata in its EXIF and text chunks, wherever they are, and whether it is
 * animated (an APNG has an `acTL` chunk).
 * Read here because the library reads only the chunks before the image data
 * (IDAT), and a PNG may carry them after it as well (libpng writes there what
 * is set late; ImageMagick puts its EXIF and text there): sharp's metadata
 * would miss them, and the original would be kept with its GPS position.
 * And it loads only an APNG's default image, reporting one page.
 */
function scanPng(input: Buffer): { kinds: string[]; animated: boolean } {
  const kinds = new Set<string>();
  let animated = false;
  // After the 8-byte signature, chunks: length, type, data, CRC.
  for (let at = 8; at + 8 <= input.length;) {
    const length = input.readUInt32BE(at);
    const type = input.toString('latin1', at + 4, at + 8);
    if (type === 'IEND') break;
    if (type === 'acTL') {
      animated = true;
    } else if (type === 'eXIf') {
      kinds.add('exif');
    } else if (
      type === 'iTXt' &&
      input.toString('latin1', at + 8, at + 8 + XMP_KEYWORD.length) ===
        XMP_KEYWORD
    ) {
      kinds.add('xmp');
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      kinds.add('comments');
    }
    at += 12 + length;
  }
  return { kinds: [...kinds], animated };
}

/**
 * Whether a WebP is lossless: its image data is a `VP8L` chunk, not `VP8 `.
 * sharp's metadata does not say, and a lossless original (a screenshot, line
 * art) re-encoded lossy would lose sharp edges and text for good.
 */
function isLosslessWebp(input: Buffer): boolean {
  // `RIFF`, the size, `WEBP`, then chunks: type, size (little-endian), data padded to even.
  for (let at = 12; at + 8 <= input.length;) {
    const type = input.toString('latin1', at, at + 4);
    if (type === 'VP8L') return true;
    if (type === 'VP8 ') return false;
    const size = input.readUInt32LE(at + 4);
    at += 8 + size + (size % 2);
  }
  return false;
}

/** Runs one conversion; the library's errors become an `ImageRejectedError` with the reason. */
async function attempt<T>(convert: () => Promise<T>): Promise<T> {
  try {
    return await convert();
  } catch (error) {
    if (error instanceof ImageRejectedError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const reason: ImageRejection = /pixel limit/i.test(message)
      ? 'pixels'
      : /unsupported image format/i.test(message)
        ? 'format'
        : /timeout/i.test(message)
          ? 'timeout'
          : 'invalid';
    throw new ImageRejectedError(reason, message, { cause: error });
  }
}
