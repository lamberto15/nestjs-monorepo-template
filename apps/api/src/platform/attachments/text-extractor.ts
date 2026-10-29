import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

/**
 * The detected types whose text is extracted, as attachments store them
 * (detectAttachmentType): plain text, CSV, PDF, DOCX.
 */
export const EXTRACTABLE_TYPES: readonly string[] = [
  'text/plain; charset=utf-8',
  'text/csv; charset=utf-8',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

/** A content type without its parameters: `text/plain; charset=utf-8` → `text/plain`. */
const essence = (contentType: string) =>
  contentType.split(';')[0]!.trim().toLowerCase();

const EXTRACTABLE: ReadonlySet<string> = new Set(
  EXTRACTABLE_TYPES.map(essence),
);

/** Whether the text of a file of this (detected) type is extracted. */
export function isExtractable(contentType: string) {
  return EXTRACTABLE.has(essence(contentType));
}

/** The most characters of a file's text that are kept (a tsvector holds at most 1 MB). */
export const MAX_TEXT_CHARS = 200_000;

/** The heap one extraction may use, in MB: past it the thread is stopped (`memory`). */
const HEAP_MB = 256;

/**
 * Why a file's text could not be extracted. All of them are about this
 * file, so trying again changes nothing.
 * - `size`: larger than ATTACHMENT_TEXT_MAX_MB.
 * - `timeout`: over ATTACHMENT_TEXT_TIMEOUT_MS.
 * - `memory`: over the thread's heap limit (a zip or PDF bomb).
 * - `invalid`: damaged, or a type it has no extractor for.
 */
export type TextRejection = 'size' | 'timeout' | 'memory' | 'invalid';

export class TextRejectedError extends Error {
  constructor(
    readonly reason: TextRejection,
    message: string,
  ) {
    super(message);
    this.name = 'TextRejectedError';
  }
}

export interface TextExtractorOptions {
  /** The largest file read, in bytes. */
  maxBytes: number;
  /** How long one extraction may run, in milliseconds. */
  timeoutMs: number;
}

/**
 * The thread's file next to this one: `.js` when built, `.ts` when the tests
 * run the source (Node strips the types; the worker imports nothing relative).
 */
const WORKER = new URL(
  `./text-extraction.worker${extname(fileURLToPath(import.meta.url))}`,
  import.meta.url,
);

/**
 * Extracts the text of a file, for the search inside attachments. The bytes
 * are hostile until proven otherwise, so each file is read in a thread of
 * its own (text-extraction.worker.ts): no environment (no secrets), a heap
 * limit (`HEAP_MB`), a time limit after which the thread is terminated, and
 * a size limit checked before it starts. A crash, a bomb or a hang ends that
 * thread, never the worker process. It knows nothing of attachments or
 * storage (AttachmentTextService does).
 */
export class TextExtractor {
  constructor(private readonly options: TextExtractorOptions) {}

  get maxBytes() {
    return this.options.maxBytes;
  }

  /** The file's text, at most `MAX_TEXT_CHARS`; a TextRejectedError when it can't be had. */
  extract(bytes: Uint8Array, contentType: string): Promise<string> {
    if (bytes.byteLength > this.options.maxBytes) {
      return Promise.reject(
        new TextRejectedError(
          'size',
          `The file is ${bytes.byteLength} bytes; at most ${this.options.maxBytes} are read.`,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const worker = new Worker(WORKER, {
        workerData: {
          bytes,
          type: essence(contentType),
          maxChars: MAX_TEXT_CHARS,
        },
        env: {},
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: HEAP_MB,
          maxYoungGenerationSizeMb: 32,
        },
        stdout: true,
        stderr: true,
      });
      const finish = (error: TextRejectedError | null, text?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        if (error) reject(error);
        else resolve(text!);
      };
      const timer = setTimeout(
        () =>
          finish(
            new TextRejectedError(
              'timeout',
              `The extraction took more than ${this.options.timeoutMs} ms.`,
            ),
          ),
        this.options.timeoutMs,
      );
      worker.once('message', (text: string) => finish(null, text));
      worker.once('error', (error: Error & { code?: string }) =>
        finish(
          error.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? new TextRejectedError(
                'memory',
                `The extraction needed more than ${HEAP_MB} MB.`,
              )
            : new TextRejectedError('invalid', error.message),
        ),
      );
      worker.once('exit', (code) =>
        finish(
          new TextRejectedError(
            'invalid',
            `The extraction stopped (exit code ${code}).`,
          ),
        ),
      );
    });
  }
}
