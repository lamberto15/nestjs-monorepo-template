import { createServer, type Server } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamavScanner, parseClamdReply } from './clamav-scanner.js';
import { EICAR, MemoryMalwareScanner } from './malware-scanner.js';

/** A stand-in for clamd: records what INSTREAM sent, then answers with `reply`. */
async function fakeClamd(reply: (received: Buffer) => string | null) {
  const received: Buffer[] = [];
  const server: Server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (data) => {
      chunks.push(data);
      const all = Buffer.concat(chunks);
      // The stream ends with a zero length after the command.
      if (all.subarray(-4).equals(Buffer.alloc(4))) {
        received.push(all);
        const answer = reply(all);
        if (answer !== null) socket.end(answer);
      }
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as { port: number };
  return { port, received, server };
}

describe('parseClamdReply', () => {
  it('reads clean, infected and error answers', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ infected: false });
    expect(parseClamdReply('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({
      infected: true,
      signature: 'Win.Test.EICAR_HDB-1',
    });
    expect(() =>
      parseClamdReply('INSTREAM size limit exceeded. ERROR\0'),
    ).toThrow(/size limit/);
    expect(() => parseClamdReply('')).toThrow(/nothing/);
    expect(parseClamdReply('stream: OK\0\0\0')).toEqual({ infected: false });
    expect(() => parseClamdReply('\0\0')).toThrow(/nothing/);
  });

  it('reads a reply of many NULs and then text in linear time', () => {
    // A regex for the trailing NULs, /\0+$/, takes about a second here
    // (quadratic); the loop, well under a millisecond.
    const reply = `${'\0'.repeat(50_000)}stream: OK`;
    const started = performance.now();
    expect(() => parseClamdReply(reply)).toThrow(/clamd answered/);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('ClamavScanner', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  const scanner = (port: number, timeoutMs = 2000) =>
    new ClamavScanner({ host: '127.0.0.1', port, timeoutMs });

  it('streams the file as zINSTREAM length-prefixed chunks and reads the verdict', async () => {
    const clamd = await fakeClamd(() => 'stream: OK\0');
    server = clamd.server;
    const file = Buffer.alloc(150_000, 7);
    const result = await scanner(clamd.port).scan(Readable.from([file]));
    expect(result).toEqual({ infected: false });
    const sent = clamd.received[0]!;
    expect(sent.subarray(0, 10).toString()).toBe('zINSTREAM\0');
    // 64 KiB + 64 KiB + the rest, each after its 4-byte big-endian length, then 0.
    let at = 10;
    const lengths: number[] = [];
    while (at < sent.length) {
      const length = sent.readUInt32BE(at);
      lengths.push(length);
      at += 4 + length;
    }
    expect(lengths).toEqual([65536, 65536, 150_000 - 131_072, 0]);
  });

  it('reports the signature of an infected file', async () => {
    const clamd = await fakeClamd(() => 'stream: Eicar-Test-Signature FOUND\0');
    server = clamd.server;
    expect(
      await scanner(clamd.port).scan(Readable.from([Buffer.from(EICAR)])),
    ).toEqual({ infected: true, signature: 'Eicar-Test-Signature' });
  });

  it('throws, never answers clean, when clamd errors, is away, or is silent', async () => {
    const limit = await fakeClamd(
      () => 'INSTREAM size limit exceeded. ERROR\0',
    );
    server = limit.server;
    await expect(
      scanner(limit.port).scan(Readable.from([Buffer.from('x')])),
    ).rejects.toThrow(/size limit/);

    const port = limit.port;
    limit.server.close();
    await expect(
      scanner(port).scan(Readable.from([Buffer.from('x')])),
    ).rejects.toThrow();

    const silent = await fakeClamd(() => null);
    server = silent.server;
    await expect(
      scanner(silent.port, 1000).scan(Readable.from([Buffer.from('x')])),
    ).rejects.toThrow(/did not answer/);
  });
});

describe('MemoryMalwareScanner', () => {
  it('flags the EICAR string and throws while down', async () => {
    const scanner = new MemoryMalwareScanner();
    expect(await scanner.scan(Readable.from([Buffer.from('hello')]))).toEqual({
      infected: false,
    });
    expect(
      await scanner.scan(Readable.from([Buffer.from(`x${EICAR}y`)])),
    ).toMatchObject({ infected: true });
    scanner.down = true;
    await expect(
      scanner.scan(Readable.from([Buffer.from('hello')])),
    ).rejects.toThrow();
    expect(scanner.scanned).toBe(3);
  });
});
