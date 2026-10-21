import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  ImageProcessor,
  type ImageProcessorOptions,
  ImageRejectedError,
} from './image-processor.js';

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

/** A 1-bit PNG of `size` × `size` pixels: a few KB that inflate to megapixels. */
function pngBomb(size: number) {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 1; // bit depth; grayscale, no interlace
  const row = Buffer.alloc(1 + Math.ceil(size / 8));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk(
      'IDAT',
      deflateSync(Buffer.concat(Array(size).fill(row)), { level: 9 }),
    ),
    chunk('IEND', Buffer.alloc(0)),
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

    it('a truncated picture', async () => {
      const whole = await photo();
      expect(
        await reason(whole.subarray(0, Math.floor(whole.length / 2))),
      ).toBe('invalid');
    });
  });
});
