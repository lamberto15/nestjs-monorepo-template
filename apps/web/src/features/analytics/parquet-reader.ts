import initParquetWasm, { readParquet } from 'parquet-wasm/esm';
import parquetWasmUrl from 'parquet-wasm/esm/parquet_wasm_bg.wasm?url';

let initialization: Promise<unknown> | undefined;

/** Decode Parquet locally, then transfer Arrow IPC to DuckDB's in-memory table. */
export async function parquetToArrowIPC(
  buffer: ArrayBuffer,
): Promise<Uint8Array> {
  initialization ??= initParquetWasm(parquetWasmUrl);
  await initialization;

  const table = readParquet(new Uint8Array(buffer));
  // intoIPCStream transfers the table out of WASM and frees it, per parquet-wasm.
  return table.intoIPCStream();
}
