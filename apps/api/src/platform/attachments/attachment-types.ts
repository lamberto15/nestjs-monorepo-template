import { UnsupportedMediaTypeException } from '@nestjs/common';
import { detectContentType, type UploadFileInfo } from '@nestjs/storage';

/**
 * Recognizing an attachment by its bytes. @nestjs/storage knows images and
 * PDF by their signature; this adds what it leaves to the app: Office
 * documents and zip (a zip whose first entries are `word/`, `xl/` or
 * `ppt/` is a .docx, .xlsx or .pptx) and UTF-8 text.
 */

/** How much of the start of a file `detectAttachmentType` reads. */
export const ATTACHMENT_SAMPLE_BYTES = 64 * 1024;

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OFFICE: [marker: string, type: string][] = [
  [
    'word/',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  ['xl/', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  [
    'ppt/',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
];

/** `detectContentType` of `uploadToDisk()`: a type, or undefined (refused, 415). */
export function detectAttachmentType(
  bytes: Buffer,
  file: Pick<UploadFileInfo, 'mimetype'>,
): string | undefined {
  if (bytes.length === 0) {
    return undefined;
  }
  if (bytes.subarray(0, 4).equals(ZIP)) {
    const names = zipEntryNames(bytes);
    const office = OFFICE.find(([marker]) =>
      names.some((name) => name.startsWith(marker)),
    );
    return office?.[1] ?? 'application/zip';
  }
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (bytes.length >= ATTACHMENT_SAMPLE_BYTES) {
    // The sample may end inside a character.
    text = text.replace(/�{1,3}$/, '');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F�]/.test(text)) {
    return undefined;
  }
  // Text is served as text, whatever it holds (HTML too): CSV when the client says so.
  return essence(file.mimetype) === 'text/csv'
    ? 'text/csv; charset=utf-8'
    : 'text/plain; charset=utf-8';
}

/**
 * The names of the entries whose local headers are in the sample
 * (`PK\x03\x04`, the name's length at +26, the name at +30): what the
 * archive holds, not what its compressed bytes happen to contain.
 */
function zipEntryNames(bytes: Buffer) {
  const names: string[] = [];
  let at = 0;
  while ((at = bytes.indexOf(ZIP, at)) !== -1 && at + 30 <= bytes.length) {
    const nameLength = bytes.readUInt16LE(at + 26);
    const extraLength = bytes.readUInt16LE(at + 28);
    const name = bytes.toString('latin1', at + 30, at + 30 + nameLength);
    if (name) names.push(name);
    at += 30 + nameLength + extraLength;
  }
  return names;
}

/** Types a client may declare for a file of the detected family. */
const SAME = [
  [
    'application/zip',
    'application/x-zip-compressed',
    ...OFFICE.map(([, type]) => type),
  ],
  ['image/jpeg', 'image/jpg', 'image/pjpeg'],
];

/**
 * Refuses (415) a file whose bytes say something else than the type the
 * client declared: a `.png` that is text, a `.pdf` that is a zip. A client
 * that declares nothing (`application/octet-stream`) isn't contradicted.
 */
export function assertDeclaredType(declared: string, detected: string) {
  const claimed = essence(declared);
  const actual = essence(detected);
  if (
    claimed === '' ||
    claimed === 'application/octet-stream' ||
    claimed === actual ||
    (actual.startsWith('text/') && claimed.startsWith('text/')) ||
    SAME.some((family) => family.includes(claimed) && family.includes(actual))
  ) {
    return;
  }
  throw new UnsupportedMediaTypeException(
    `The file is ${actual}, not ${claimed} as declared.`,
  );
}

const essence = (type: string | undefined) =>
  (type ?? '').split(';')[0]!.trim().toLowerCase();

/** The leading bytes `detectContentType()` of @nestjs/storage needs to recognize every signature it knows. */
const SIGNATURE_BYTES = 16;

/**
 * The type of a file's first `ATTACHMENT_SAMPLE_BYTES`, the way the upload
 * through the API decides it (`uploadToDisk()`): the storage package's
 * signatures first (images, PDF), then `detectAttachmentType`. Used on a
 * file that was not streamed through the API: a direct upload to the object
 * store, read back by a ranged GET.
 */
export function detectUploadedType(
  sample: Buffer,
  declared: string,
): string | undefined {
  return (
    detectContentType(sample.subarray(0, SIGNATURE_BYTES)) ??
    detectAttachmentType(sample, { mimetype: declared })
  );
}

/** Whether `type`, parameters aside, is one of `allowed` (ATTACHMENT_ALLOWED_TYPES). */
export const isAllowedType = (type: string, allowed: readonly string[]) =>
  allowed.some((candidate) => essence(candidate) === essence(type));

/** Other names of the types a browser may declare for a file. */
const ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'application/x-zip-compressed': 'application/zip',
};

/**
 * The `Content-Type` a direct upload is signed for, from the type the client
 * declares: what the object store keeps and serves it with, so it is one of
 * ours, not the client's spelling. Text is `text/plain` (`text/csv` for CSV),
 * with the charset, as an upload through the API stores it; a JPEG or a zip
 * under another of its names is the usual name. Undefined when the client
 * declares nothing (or `application/octet-stream`): a direct upload names its
 * type, since the store would serve whatever it was told.
 */
export function directUploadType(declared: string): string | undefined {
  const type = essence(declared);
  if (type === '' || type === 'application/octet-stream') {
    return undefined;
  }
  if (type === 'text/csv') {
    return 'text/csv; charset=utf-8';
  }
  if (type.startsWith('text/')) {
    return 'text/plain; charset=utf-8';
  }
  return ALIASES[type] ?? type;
}

/** A content type without its parameters, lowercased. */
export const sameType = (a: string, b: string) => essence(a) === essence(b);
