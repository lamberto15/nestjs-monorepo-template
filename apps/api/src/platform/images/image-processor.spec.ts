import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { ConfigService } from '@nestjs/config';
import sharp, { type Sharp } from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { PlatformEnv } from '../platform.env.js';
import {
  ImageProcessor,
  type ImageProcessorOptions,
  ImageRejectedError,
} from './image-processor.js';
import { imageProcessor } from './image-processor.factory.js';

const processor = (options: Partial<ImageProcessorOptions> = {}) =>
  new ImageProcessor({
    maxPixels: 1_000_000,
    timeoutMs: 10_000,
    stripOriginals: true,
    ...options,
  });

/** A camera's EXIF: make, model and a GPS position (the orientation is set apart: `withExif` resets it). */
const EXIF = {
  IFD0: { Make: 'ACME', Model: 'Cam 1' },
  IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 26/1 46/1' },
};

/** A solid picture `width` × `height`, as sharp builds it from nothing. */
const blank = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  });

const photo = (width = 400, height = 200) =>
  blank(width, height)
    .withExif(EXIF)
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();

const meta = (bytes: Buffer) => sharp(bytes).metadata();

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** One PNG chunk: length, type, data, CRC. */
const pngChunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

/** A PNG's chunks as they are in the file (each whole: length to CRC). */
function pngChunks(png: Buffer) {
  const chunks: { type: string; bytes: Buffer }[] = [];
  for (let at = 8; at < png.length;) {
    const end = at + 12 + png.readUInt32BE(at);
    chunks.push({
      type: png.toString('latin1', at + 4, at + 8),
      bytes: png.subarray(at, end),
    });
    at = end;
  }
  return chunks;
}

/** A 1-bit PNG of `size` × `size` pixels: a few KB that inflate to megapixels. */
function pngBomb(size: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 1; // bit depth; grayscale, no interlace
  const row = Buffer.alloc(1 + Math.ceil(size / 8));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk(
      'IDAT',
      deflateSync(Buffer.concat(Array(size).fill(row)), { level: 9 }),
    ),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * An 8-bit RGBA PNG with a text chunk (so it gets stripped) whose rows
 * compress well as written: a row of noise, then each row the one above
 * plus `step` in every byte, stored with the Up filter (each row deflates
 * to one repeated byte). Whether a re-encoded copy does depends on the
 * filters its encoder picks.
 */
function pngGrowing(width: number, height: number, step: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  randomBytes(rowBytes).copy(raw, 1); // row 0, filter None
  for (let y = 1; y < height; y++) {
    const at = y * (rowBytes + 1);
    raw[at] = 2; // Up
    raw.fill(step, at + 1, at + 1 + rowBytes);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('tEXt', Buffer.from('Comment\0made by hand', 'latin1')),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('ImageProcessor', () => {
  it('makes a thumb and a preview, upright, WebP, without metadata', async () => {
    // 400 × 200 with Orientation 6: shown as 200 × 400.
    const result = await processor().process(await photo());

    const { thumb, preview } = result.renditions;
    expect(thumb).toMatchObject({
      contentType: 'image/webp',
      width: 128,
      height: 256,
    });
    // Never enlarged: the preview box (1600) is larger than the picture.
    expect(preview).toMatchObject({ width: 200, height: 400 });
    for (const { data, width, height } of [thumb, preview]) {
      const info = await meta(data);
      expect(info).toMatchObject({ format: 'webp', width, height });
      expect(info.exif).toBeUndefined();
      expect(info.orientation).toBeUndefined();
    }
  });

  it('shrinks a large picture into the box and keeps its proportions', async () => {
    const big = await blank(3000, 1500).jpeg().toBuffer();
    const { thumb, preview } = (
      await processor({ maxPixels: 10_000_000 }).process(big)
    ).renditions;
    expect([thumb.width, thumb.height]).toEqual([256, 128]);
    expect([preview.width, preview.height]).toEqual([1600, 800]);
  });

  it('re-encodes an original that carries metadata without it, upright', async () => {
    const original = await photo();
    expect((await meta(original)).exif).toBeDefined();

    const { stripped } = await processor().process(original);

    expect(stripped?.removed).toEqual(['exif']);
    const info = await meta(stripped!.data);
    expect(info).toMatchObject({ format: 'jpeg', width: 200, height: 400 });
    expect(info.exif).toBeUndefined();
    expect(info.orientation).toBeUndefined();
    // The maker and the model were in the bytes of the original, and are not any more.
    expect(original.includes(Buffer.from('Cam 1'))).toBe(true);
    expect(stripped!.data.includes(Buffer.from('ACME'))).toBe(false);
    expect(stripped!.data.includes(Buffer.from('Cam 1'))).toBe(false);
  });

  it('leaves an original without metadata byte for byte (no result to store)', async () => {
    const plain = await blank(300, 200).jpeg().toBuffer();
    const result = await processor().process(plain);
    expect(result.stripped).toBeUndefined();
    expect(result.renditions.thumb.width).toBe(256);
  });

  it('keeps the original as it is with stripping off, and still strips the renditions', async () => {
    const result = await processor({ stripOriginals: false }).process(
      await photo(),
    );
    expect(result.stripped).toBeUndefined();
    expect((await meta(result.renditions.preview.data)).exif).toBeUndefined();
  });

  it('strips a PNG (EXIF in its eXIf chunk) without changing a pixel', async () => {
    const original = await blank(40, 30)
      .withExif({ IFD0: { Make: 'ACME' } })
      .png()
      .toBuffer();
    expect((await meta(original)).exif).toBeDefined();

    const { stripped } = await processor().process(original);

    expect(stripped?.removed).toContain('exif');
    expect((await meta(stripped!.data)).format).toBe('png');
    expect((await meta(stripped!.data)).exif).toBeUndefined();
    const before = await sharp(original).raw().toBuffer();
    const after = await sharp(stripped!.data).raw().toBuffer();
    expect(after.equals(before)).toBe(true);
  });

  it('keeps a palette PNG a palette PNG with the same colours', async () => {
    const original = await blank(40, 30)
      .withExif({ IFD0: { Make: 'ACME' } })
      .png({ palette: true })
      .toBuffer();
    const before = await meta(original);
    expect(before.isPalette).toBe(true);

    const { stripped } = await processor().process(original);

    const after = await meta(stripped!.data);
    expect(after.isPalette).toBe(true);
    expect(after.exif).toBeUndefined();
    const same = (await sharp(stripped!.data).raw().toBuffer()).equals(
      await sharp(original).raw().toBuffer(),
    );
    expect(same).toBe(true);
  });

  it('strips a WebP', async () => {
    const original = await blank(60, 40)
      .withExif({ IFD0: { Make: 'ACME' } })
      .webp()
      .toBuffer();
    const { stripped } = await processor().process(original);
    expect((await meta(stripped!.data)).format).toBe('webp');
    expect((await meta(stripped!.data)).exif).toBeUndefined();
  });

  it('strips a lossless WebP without changing a pixel (it stays lossless)', async () => {
    // Line art: sharp edges that a lossy copy would blur.
    const pixels = Buffer.alloc(64 * 48 * 3);
    for (let at = 0; at < pixels.length; at++) {
      pixels[at] = (at * 37) % 251 < 125 ? 0 : 255;
    }
    const original = await sharp(pixels, {
      raw: { width: 64, height: 48, channels: 3 },
    })
      .withExif({ IFD0: { Make: 'ACME' } })
      .webp({ lossless: true })
      .toBuffer();
    expect((await meta(original)).exif).toBeDefined();

    const { stripped } = await processor().process(original);

    expect(stripped?.removed).toEqual(['exif']);
    expect((await meta(stripped!.data)).exif).toBeUndefined();
    expect(stripped!.data.includes(Buffer.from('VP8L'))).toBe(true);
    const before = await sharp(original).raw().toBuffer();
    const after = await sharp(stripped!.data).raw().toBuffer();
    expect(after.equals(before)).toBe(true);
  });

  it('strips a PNG whose metadata comes after the image data', async () => {
    // EXIF, XMP and text where the library does not look: after IDAT.
    const xmp =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="48,51.5N"/></rdf:RDF></x:xmpmeta>';
    const chunks = pngChunks(
      await blank(40, 30).withExif(EXIF).png().toBuffer(),
    );
    const late = (type: string) => type === 'eXIf';
    const original = Buffer.concat([
      PNG_SIGNATURE,
      ...chunks
        .filter(({ type }) => type !== 'IEND' && !late(type))
        .map(({ bytes }) => bytes),
      ...chunks.filter(({ type }) => late(type)).map(({ bytes }) => bytes),
      pngChunk('tEXt', Buffer.from('Location\0Paris', 'latin1')),
      pngChunk(
        'iTXt',
        Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${xmp}`, 'latin1'),
      ),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    const types = pngChunks(original).map(({ type }) => type);
    expect(types.indexOf('eXIf')).toBeGreaterThan(types.indexOf('IDAT'));
    // What the library reports of it: nothing.
    const reported = await meta(original);
    expect([reported.exif, reported.xmp, reported.comments]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);

    const { stripped } = await processor().process(original);

    expect(stripped?.removed).toEqual(['exif', 'xmp', 'comments']);
    for (const text of ['eXIf', 'tEXt', 'iTXt', 'ACME', 'GPS', 'Paris']) {
      expect(original.includes(Buffer.from(text))).toBe(true);
      expect(stripped!.data.includes(Buffer.from(text))).toBe(false);
    }
    const before = await sharp(original).raw().toBuffer();
    const after = await sharp(stripped!.data).raw().toBuffer();
    expect(after.equals(before)).toBe(true);
  });

  it.each([
    ['before the image data', true],
    ['after the image data', false],
  ])(
    'leaves an animated PNG with text %s as uploaded (a copy would be a still)',
    async (_where, early) => {
      const chunks = pngChunks(await blank(40, 30).png().toBuffer());
      const chunk = (type: string) =>
        chunks.find((found) => found.type === type)!.bytes;
      const [IHDR, IDAT] = [chunk('IHDR'), chunk('IDAT')];
      const text = pngChunk(
        'tEXt',
        Buffer.from('Software\0Animator', 'latin1'),
      );
      // Two frames: acTL (frames, plays), then fcTL + IDAT and fcTL + fdAT
      // (each with a sequence number).
      const u32 = (...values: number[]) => {
        const out = Buffer.alloc(values.length * 4);
        values.forEach((value, at) => out.writeUInt32BE(value, at * 4));
        return out;
      };
      const frameControl = (sequence: number) =>
        pngChunk(
          'fcTL',
          Buffer.concat([
            u32(sequence, 40, 30, 0, 0),
            Buffer.from([0, 1, 0, 10, 0, 0]), // delay 1/10 s, dispose, blend
          ]),
        );
      const original = Buffer.concat([
        PNG_SIGNATURE,
        IHDR,
        pngChunk('acTL', u32(2, 0)),
        ...(early ? [text] : []),
        frameControl(0),
        IDAT,
        frameControl(1),
        pngChunk('fdAT', Buffer.concat([u32(2), IDAT.subarray(8, -4)])),
        ...(early ? [] : [text]),
        pngChunk('IEND', Buffer.alloc(0)),
      ]);
      expect(pngChunks(original).map(({ type }) => type)).toContain('acTL');
      // The library loads only the default image, so it cannot tell.
      expect((await meta(original)).pages).toBeUndefined();
      expect((await meta(original)).format).toBe('png');

      const result = await processor().process(original);

      expect(result.stripped).toBeUndefined();
      expect(result.renditions.thumb).toMatchObject({ width: 40, height: 30 });
    },
  );

  it('writes a stripped PNG with row filters, about as small as it was', async () => {
    // Each row the one above plus 1: the Up filter, which an encoder that
    // chooses its filters finds again. Unfiltered, 4 KB would become 1 MB.
    const original = pngGrowing(512, 512, 1);
    const { stripped } = await processor().process(original);
    expect(stripped?.removed).toEqual(['comments']);
    expect(stripped!.data.length).toBeLessThan(original.length * 2);
  });

  it('makes renditions of a GIF from its first frame and leaves the GIF alone', async () => {
    const gif = await blank(500, 300).gif().toBuffer();
    const result = await processor().process(gif);
    expect(result.stripped).toBeUndefined();
    expect(result.renditions.thumb).toMatchObject({ width: 256, height: 154 });
  });

  it('keeps transparency in the renditions of a PNG', async () => {
    const png = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const result = await processor().process(png);
    expect((await meta(result.renditions.thumb.data)).hasAlpha).toBe(true);
  });

  describe('refuses', () => {
    const reason = async (
      input: Buffer,
      options?: Partial<ImageProcessorOptions>,
    ) => {
      const error = await processor(options)
        .process(input)
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(error).toBeInstanceOf(ImageRejectedError);
      return (error as ImageRejectedError).reason;
    };

    it('a picture over the pixel limit, before decoding it', async () => {
      // 4 KB of PNG that claim 40 megapixels, against a limit of 1.
      const bomb = pngBomb(6400);
      expect(bomb.length).toBeLessThan(100_000);
      expect(await reason(bomb)).toBe('pixels');
      expect(await reason(await photo(), { maxPixels: 1000 })).toBe('pixels');
    });

    it('bytes that are not an image', async () => {
      expect(
        await reason(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
      ).toBe('format');
      expect(await reason(Buffer.from('just text'))).toBe('format');
    });

    it('a format the processor does not take (TIFF)', async () => {
      expect(await reason(await blank(10, 10).tiff().toBuffer())).toBe(
        'format',
      );
    });

    it('a PNG whose stripped copy would be many times larger', async () => {
      // Each row the one above plus 0x81: the Up filter would give one
      // repeated byte, but an encoder's heuristic (the smallest sum of
      // differences) never picks it, and rows longer than deflate's 32 KB
      // window can't repeat one another. 33 KB that would be stored as 2 MB.
      const original = pngGrowing(8200, 64, 0x81);
      expect(original.length).toBeLessThan(40_000);
      expect(await reason(original)).toBe('size');
    });

    it('a conversion over the time limit', async () => {
      // A real one needs a picture that takes more than a whole second:
      // the library's own error (`timeout: N% complete`) stands in for it.
      const input = await photo();
      const toBuffer = vi
        .spyOn(sharp.prototype as Sharp, 'toBuffer')
        .mockRejectedValueOnce(new Error('timeout: 40% complete'));
      try {
        expect(await reason(input)).toBe('timeout');
      } finally {
        toBuffer.mockRestore();
      }
    });

    it('a truncated picture', async () => {
      const whole = await photo();
      expect(
        await reason(whole.subarray(0, Math.floor(whole.length / 2))),
      ).toBe('invalid');
    });
  });

  it('gives the library the time limit of IMAGE_TIMEOUT_MS, in whole seconds, on every conversion', async () => {
    const input = await photo();
    const timeout = vi.spyOn(sharp.prototype as Sharp, 'timeout');
    try {
      await processor({ timeoutMs: 1000 }).process(input);
      expect(timeout).toHaveBeenCalledWith({ seconds: 1 });

      timeout.mockClear();
      const settings: Partial<PlatformEnv> = {
        IMAGE_MAX_PIXELS: 1_000_000,
        IMAGE_TIMEOUT_MS: 2500,
        IMAGE_STRIP_ORIGINALS: true,
      };
      const config = {
        get: (key: keyof PlatformEnv) => settings[key],
      } as unknown as ConfigService<PlatformEnv, true>;
      await imageProcessor(config).process(input);
      // The metadata, two renditions and the stripped copy: each one limited.
      expect(timeout.mock.calls).toEqual(
        Array.from({ length: 4 }, () => [{ seconds: 3 }]),
      );
    } finally {
      timeout.mockRestore();
    }
  });
});
