import { connect } from 'node:net';
import type { Readable } from 'node:stream';
import { trimEnd } from '../../core/text/trim.js';
import { MalwareScanner, type ScanResult } from './malware-scanner.js';

/** Bytes per INSTREAM chunk (clamd's StreamMaxLength is the file's, not the chunk's, limit). */
const CHUNK = 64 * 1024;

export interface ClamavOptions {
  host: string;
  port: number;
  timeoutMs: number;
}

/**
 * Parses clamd's answer to INSTREAM (`stream: OK`, `stream: <name> FOUND`,
 * `<message> ERROR`), a NUL-terminated line. An error is thrown: a file
 * clamd could not scan is not a clean one.
 */
export function parseClamdReply(reply: string): ScanResult {
  const text = trimEnd(reply, '\0').trim();
  if (text === 'stream: OK') {
    return { infected: false };
  }
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) {
    return { infected: true, signature: found[1]! };
  }
  throw new Error(`clamd answered: ${text || '(nothing)'}`);
}

/**
 * clamd over TCP, the INSTREAM command
 * (https://docs.clamav.net/manual/Usage/Scanning.html#clamd): `zINSTREAM\0`,
 * then the file as chunks of a 4-byte big-endian length and the bytes, then
 * a zero length; clamd answers one NUL-terminated line. Custom code on
 * purpose: the protocol is about forty lines, and the npm clients are
 * unmaintained (`clamdjs` last released in 2022, `clamscan` in 2024, which
 * also drives local binaries and callbacks). The file is streamed, never
 * held in memory; the socket's backpressure paces the read. One connection
 * per scan, closed after the answer. clamd's `StreamMaxLength` must be at
 * least ATTACHMENT_MAX_MB, else it answers "INSTREAM size limit exceeded"
 * (an error: the scan fails, the file stays pending).
 */
export class ClamavScanner extends MalwareScanner {
  readonly enabled = true;

  constructor(private readonly options: ClamavOptions) {
    super();
  }

  scan(file: Readable): Promise<ScanResult> {
    const { host, port, timeoutMs } = this.options;
    return new Promise<ScanResult>((resolve, reject) => {
      const socket = connect({ host, port });
      const reply: Buffer[] = [];
      let settled = false;
      const done = (error?: Error, result?: ScanResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        file.destroy();
        if (error) reject(error);
        else resolve(result!);
      };
      socket.setTimeout(timeoutMs, () =>
        done(new Error(`clamd did not answer within ${timeoutMs} ms.`)),
      );
      socket.on('error', (error) => done(error));
      socket.on('data', (chunk) => reply.push(chunk));
      socket.on('end', () => {
        try {
          done(
            undefined,
            parseClamdReply(Buffer.concat(reply).toString('utf8')),
          );
        } catch (error) {
          done(error as Error);
        }
      });
      socket.on('close', () =>
        done(new Error('clamd closed the connection without an answer.')),
      );
      socket.on('connect', () => {
        void (async () => {
          try {
            socket.write('zINSTREAM\0');
            for await (const bytes of file) {
              const data = Buffer.from(bytes as Uint8Array);
              for (let at = 0; at < data.length; at += CHUNK) {
                const part = data.subarray(at, at + CHUNK);
                const length = Buffer.alloc(4);
                length.writeUInt32BE(part.length);
                if (!socket.write(Buffer.concat([length, part]))) {
                  await new Promise<void>((resume) => {
                    socket.once('drain', resume);
                    socket.once('close', resume); // never waits on a dead socket
                  });
                }
                if (settled) return; // clamd already answered (a limit) or failed
              }
            }
            socket.write(Buffer.alloc(4)); // the zero length ends the stream
          } catch (error) {
            done(error as Error);
          }
        })();
      });
    });
  }
}
