import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasm = vi.hoisted(() => ({ initialize: vi.fn(), read: vi.fn() }));
vi.mock('parquet-wasm/esm', () => ({
  default: wasm.initialize,
  readParquet: wasm.read,
}));

beforeEach(() => {
  vi.resetModules();
  wasm.initialize.mockReset().mockResolvedValue({});
  wasm.read.mockReset();
});

describe('local Parquet decoder', () => {
  it('can retry an import after a temporary decoder download failure', async () => {
    wasm.initialize.mockRejectedValueOnce(new Error('temporarily offline'));
    const { parquetToArrowIPC } = await import('./parquet-reader');
    await expect(parquetToArrowIPC(new ArrayBuffer(0))).rejects.toThrow(
      'temporarily offline',
    );

    const ipc = new Uint8Array([1, 2, 3]);
    wasm.read.mockReturnValue({ intoIPCStream: () => ipc });
    expect(await parquetToArrowIPC(new ArrayBuffer(1))).toEqual(ipc);
  });

  it('keeps the initialized decoder usable after one malformed file', async () => {
    const { parquetToArrowIPC } = await import('./parquet-reader');
    wasm.read.mockImplementationOnce(() => {
      throw new Error('invalid Parquet');
    });
    await expect(parquetToArrowIPC(new ArrayBuffer(1))).rejects.toThrow(
      'invalid Parquet',
    );

    const ipc = new Uint8Array([4, 5, 6]);
    wasm.read.mockReturnValue({ intoIPCStream: () => ipc });
    expect(await parquetToArrowIPC(new ArrayBuffer(2))).toEqual(ipc);
    expect(wasm.initialize).toHaveBeenCalledTimes(1);
  });
});
