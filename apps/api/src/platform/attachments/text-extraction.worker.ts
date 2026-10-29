/**
 * The thread TextExtractor starts for one file: it reads the text out of the
 * bytes it is given and posts it back. It runs with no environment (no
 * secrets), a heap limit and a time limit set by its parent, and has nothing
 * of the app: no relative imports, so Node can also start it from the
 * TypeScript source (tests), and no database or disk.
 *
 * - Plain text and CSV: decoded as UTF-8.
 * - PDF: unpdf (Mozilla's pdf.js for servers), without eval (font programs
 *   are interpreted, not compiled: CVE-2024-4367) and without fetching fonts
 *   or anything else; the data is in memory.
 * - DOCX: mammoth's raw text; its XML parser (@xmldom/xmldom) resolves no
 *   external entity and loads nothing outside the archive.
 */
import { parentPort, workerData } from 'node:worker_threads';

interface Input {
  bytes: Uint8Array;
  /** The detected type, without parameters: `application/pdf`. */
  type: string;
  maxChars: number;
}

async function extract({ bytes, type }: Input): Promise<string> {
  if (type === 'text/plain' || type === 'text/csv') {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  if (type === 'application/pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(bytes, {
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  if (
    type ===
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const { default: mammoth } = await import('mammoth');
    const { value } = await mammoth.extractRawText({
      buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    });
    return value;
  }
  throw new Error(`No extractor for ${type}.`);
}

const input = workerData as Input;
const text = await extract(input);
// PostgreSQL's text holds no NUL; whitespace runs say nothing to a search.
parentPort!.postMessage(
  text
    .replaceAll('\0', ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, input.maxChars),
);
