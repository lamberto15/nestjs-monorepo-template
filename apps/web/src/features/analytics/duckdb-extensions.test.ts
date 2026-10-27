import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import extensions from './duckdb-extensions.json';

const webRoot = join(import.meta.dirname, '../../..');
const require = createRequire(join(webRoot, 'package.json'));

describe('vendored DuckDB extensions', () => {
  it('are for the DuckDB version the installed duckdb-wasm runs', async () => {
    // The wasm bundles do not declare their DuckDB version anywhere else, so ask
    // the package's Node build, which embeds the same engine. A Dependabot bump
    // that moves it fails here until `pnpm duckdb:extensions --record` is run.
    const dist = dirname(require.resolve('@duckdb/duckdb-wasm'));
    const node = require(join(dist, 'duckdb-node-blocking.cjs'));
    const db = await node.createDuckDB(
      {
        mvp: { mainModule: join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
        eh: { mainModule: join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
      },
      new node.VoidLogger(),
      node.NODE_RUNTIME,
    );
    await db.instantiate(() => undefined);
    db.open({});
    const conn = db.connect();
    const version = String(
      conn.query('SELECT version() AS v').getChildAt(0)!.get(0),
    );
    conn.close();
    expect(version).toBe(`v${extensions.duckdbVersion}`);
  });

  it('match their pinned SHA-256 in every platform and extension', () => {
    for (const platform of extensions.platforms) {
      for (const name of extensions.extensions) {
        const path = join(
          webRoot,
          'public/duckdb-extensions',
          `v${extensions.duckdbVersion}`,
          platform,
          `${name}.duckdb_extension.wasm`,
        );
        const pinned = (extensions.sha256 as Record<string, string>)[
          `${platform}/${name}`
        ];
        expect(pinned).toMatch(/^[0-9a-f]{64}$/);
        expect(
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        ).toBe(pinned);
      }
    }
  });
});
