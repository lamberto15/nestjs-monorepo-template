import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  isExtractable,
  TextExtractor,
  TextRejectedError,
} from './text-extractor.js';

const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A one-page PDF that shows `text` in Helvetica. */
function pdf(text: string) {
  const stream = `BT /F1 12 Tf 72 712 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets
    .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
    .join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A zip of `files`, stored (not compressed). */
function zip(files: Record<string, string>) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const fileName = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(fileName.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(fileName.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(header, fileName, data);
    central.push(entry, fileName);
    offset += header.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function docx(text: string) {
  return zip({
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  });
}

const extractor = new TextExtractor({
  maxBytes: 1024 * 1024,
  timeoutMs: 20_000,
});

describe('isExtractable', () => {
  it('takes text, CSV, PDF and DOCX, whatever their parameters', () => {
    expect(isExtractable('text/plain; charset=utf-8')).toBe(true);
    expect(isExtractable('text/csv; charset=utf-8')).toBe(true);
    expect(isExtractable('application/pdf')).toBe(true);
    expect(isExtractable(DOCX)).toBe(true);
    expect(isExtractable('image/png')).toBe(false);
    expect(isExtractable('application/zip')).toBe(false);
  });
});

// Each extraction starts a thread that loads its library: seconds when cold.
describe('TextExtractor', { timeout: 30_000 }, () => {
  it('reads plain text, without NUL and with its whitespace collapsed', async () => {
    await expect(
      extractor.extract(
        Buffer.from('Quarterly\u0000 report\n\n  zebra '),
        'text/plain; charset=utf-8',
      ),
    ).resolves.toBe('Quarterly report zebra');
  });

  it('reads the text of a PDF', async () => {
    await expect(
      extractor.extract(pdf('Quarterly invoice zebra'), 'application/pdf'),
    ).resolves.toBe('Quarterly invoice zebra');
  });

  it('reads the text of a DOCX', async () => {
    await expect(
      extractor.extract(docx('Signed contract zebra'), DOCX),
    ).resolves.toBe('Signed contract zebra');
  });

  it('refuses a file over the size limit without reading it', async () => {
    const small = new TextExtractor({ maxBytes: 4, timeoutMs: 20_000 });
    await expect(
      small.extract(Buffer.from('too long'), 'text/plain'),
    ).rejects.toMatchObject({ reason: 'size' });
  });

  it('refuses a damaged file', async () => {
    const error = await extractor
      .extract(Buffer.from('%PDF-1.4 nothing else'), 'application/pdf')
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(TextRejectedError);
    expect(error).toMatchObject({ reason: 'invalid' });
  });

  it('stops an extraction over the time limit', async () => {
    const hurried = new TextExtractor({ maxBytes: 1024 * 1024, timeoutMs: 1 });
    await expect(
      hurried.extract(pdf('slow'), 'application/pdf'),
    ).rejects.toMatchObject({ reason: 'timeout' });
  });
});
