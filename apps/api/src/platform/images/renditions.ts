/**
 * The derived files of an uploaded image (docs/attachments.md, "Image
 * renditions"). Plain types and numbers, no image library: the tables, the
 * API schemas and the processor all read them.
 */

/**
 * What is made of an image: `thumb` for lists (fits in 256 × 256 pixels),
 * `preview` for a larger view (fits in 1600 × 1600). Never enlarged: an image
 * smaller than the box keeps its size. Both are WebP, rotated upright and
 * stripped of all metadata.
 */
export const RENDITION_NAMES = ['thumb', 'preview'] as const;
export type RenditionName = (typeof RENDITION_NAMES)[number];

export const RENDITION_SPECS: Record<
  RenditionName,
  {
    /** Longest side, in pixels. */ px: number;
    /** WebP quality (1 to 100). */ quality: number;
  }
> = {
  thumb: { px: 256, quality: 75 },
  preview: { px: 1600, quality: 80 },
};

/** Every rendition is a WebP (every current browser shows it, with transparency). */
export const RENDITION_CONTENT_TYPE = 'image/webp';

/**
 * The types that are processed, as the bytes were detected at upload
 * (`attachments.content_type`). SVG is not among them (it is not an image
 * the storage package detects, and a vector renderer has no business with
 * uploads); AVIF and HEIC are skipped: decoding them is heavy and the
 * prebuilt library has no HEVC. A type that is not here is stored as it was
 * uploaded, with no renditions and no processing state.
 */
export const IMAGE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/** Whether an image of this content type gets renditions. */
export const isProcessable = (contentType: string) =>
  IMAGE_INPUT_TYPES.has(contentType.split(';')[0]!.trim().toLowerCase());

/**
 * Where a rendition is on the private disk and what it is, as the attachment
 * row keeps it (`attachments.renditions`). The key is the processing run's
 * own, unique to it (two jobs on one image never share a file):
 * `…/attachments/<uuid>.thumb.webp`; a stripped original written by the same
 * run is `…/attachments/<uuid>.jpg`.
 */
export interface StoredRendition {
  key: string;
  /** Bytes. */
  size: number;
  /** Pixels (after rotating it upright). */
  width: number;
  height: number;
  contentType: string;
}
export type StoredRenditions = Partial<Record<RenditionName, StoredRendition>>;

/**
 * `pending`: queued (or running); the original can be downloaded meanwhile.
 * `ready`: the renditions exist (and the original's metadata is gone, unless
 * IMAGE_STRIP_ORIGINALS is off). `failed`: the image could not be processed
 * (too many pixels, damaged, a format the library refuses); the original is
 * as it was uploaded. Null: not an image to process, or IMAGE_PROCESSING was
 * off at upload.
 */
export type RenditionStatus = 'pending' | 'ready' | 'failed';

/** What a client is told of a rendition: its shape, never where it is stored. */
export type PublicRendition = Omit<StoredRendition, 'key'>;
export type PublicRenditions = Partial<Record<RenditionName, PublicRendition>>;

export function publicRenditions(
  renditions: StoredRenditions,
): PublicRenditions {
  const shown: PublicRenditions = {};
  for (const name of RENDITION_NAMES) {
    const rendition = renditions[name];
    if (rendition) {
      const { key: _key, ...rest } = rendition;
      shown[name] = rest;
    }
  }
  return shown;
}

/** The keys of the files a row's renditions are stored under. */
export const renditionKeys = (renditions: StoredRenditions): string[] =>
  Object.values(renditions).map((rendition) => rendition.key);
