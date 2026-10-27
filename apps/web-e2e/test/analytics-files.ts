import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// The slice of DuckDB-Wasm's Node build used here.
interface NodeConnection {
  query(sql: string): unknown;
  close(): void;
}
interface NodeDuckDB {
  instantiate(progress: () => void): Promise<void>;
  open(config: object): void;
  connect(): NodeConnection;
}
interface NodeBundle {
  createDuckDB(
    bundles: Record<string, { mainModule: string; mainWorker: string }>,
    logger: unknown,
    runtime: unknown,
  ): Promise<NodeDuckDB>;
  VoidLogger: new () => unknown;
  NODE_RUNTIME: unknown;
}

/**
 * A small Parquet file (name, amount), written by DuckDB-Wasm's own Node build:
 * nothing else in the repository writes Parquet, and a binary fixture is not
 * written by hand. Made on each run, so the file always matches the engine the
 * web app ships.
 */
export async function parquetFile(): Promise<Buffer> {
  const webRequire = createRequire(
    resolve(import.meta.dirname, '../../web/package.json'),
  );
  // The package's main entry sits in its dist folder, next to the wasm files.
  const dist = dirname(webRequire.resolve('@duckdb/duckdb-wasm'));
  const node = webRequire(`${dist}/duckdb-node-blocking.cjs`) as NodeBundle;
  const db = await node.createDuckDB(
    {
      mvp: { mainModule: `${dist}/duckdb-mvp.wasm`, mainWorker: '' },
      eh: { mainModule: `${dist}/duckdb-eh.wasm`, mainWorker: '' },
    },
    new node.VoidLogger(),
    node.NODE_RUNTIME,
  );
  await db.instantiate(() => undefined);
  db.open({});
  const connection = db.connect();
  const directory = mkdtempSync(join(tmpdir(), 'analytics-e2e-'));
  try {
    const path = join(directory, 'tiny.parquet');
    connection.query(
      `COPY (SELECT * FROM (VALUES ('epsilon', 3::INTEGER), ('zeta', 11::INTEGER)) t(name, amount)) TO '${path}' (FORMAT parquet)`,
    );
    return readFileSync(path);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true });
  }
}

/** A CSV of `rows` lines of two numbers: big enough that reading it takes a moment. */
export function bigCsv(rows: number): Buffer {
  const lines = ['id,amount'];
  for (let id = 0; id < rows; id++) lines.push(`${id},${(id * 7919) % 10007}`);
  return Buffer.from(lines.join('\n') + '\n');
}
