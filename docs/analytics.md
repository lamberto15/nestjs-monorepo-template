# Analytics engine feasibility

## Decision

**Do not add DuckDB to the production API or worker yet.** The current platform analytics job writes a small, daily, anonymized aggregate table in PostgreSQL; it has no analytical query surface that needs a second engine. The import path is a separate question: JSON and XLSX parsing happen in the data-transfer worker, and there is no evidence yet that DuckDB improves the supported import behavior enough to justify a native runtime dependency.

This is a no-go for a production dependency pending measurements and a compatibility review. It is not a claim that DuckDB is slower or unsuitable. The import path stays on the library-based readers (ExcelJS loads a workbook whole under the size limit, CSV streams); an earlier worker-side rewrite with a DuckDB probe was reverted (#695), and no DuckDB measurements of the worker import path are kept here.

## Engine and API checked

DuckDB's official Node bindings documentation describes `@duckdb/node-api` as the Promise based API backed by the C API, and lists Linux x64/arm64 glibc and musl, macOS, and Windows packages. The published `1.5` line checked for this work reaches `1.5.6-r.2`; the package's `lts-v1.4` tag is `1.4.5-r.1`, and its moving `latest` tag is already `2.0.0-r.1`. Pin the explicit 1.5 release in any reproduction; never use `latest` for this comparison. DuckDB releases and native prebuilds must match the deployment's OS and libc.

- [DuckDB Node bindings README](https://github.com/duckdb/duckdb-node-neo/blob/main/api/pkgs/%40duckdb/node-api/README.md)
- [DuckDB Node bindings package](https://www.npmjs.com/package/%40duckdb/node-api)
- [DuckDB releases](https://github.com/duckdb/duckdb/releases)
- [DuckDB WASM package](https://www.npmjs.com/package/@duckdb/duckdb-wasm)

## Browser exploration

A single headless Chromium probe loaded synthetic CSV files of 50,200,014,
251,000,014, and 502,000,014 bytes and returned a 100-row query in 2.40, 5.51,
and 7.50 seconds, respectively. Each case used a fresh browser, a numeric group
column, and a repetitive 1,000-character text column (50,000 / 250,000 / 500,000
rows). No page error or browser crash occurred. RSS was not sampled; these
low-cardinality fixtures do not establish memory limits or performance for
typical user data. Large-file Firefox/WebKit cases remain unmeasured.

The existing application script budget remains 1.1 MB Brotli and the entry
budgets remain unchanged. Optional analytics scripts have a separate 360 kB
Brotli budget (343.55 kB measured: the package plus the MVP and EH workers); their
self-hosted Wasm assets have an 80 MB uncompressed budget (73.61 MB measured for
both bundles; a browser fetches only the one `selectBundle` picks).
These engine assets are fetched on use and excluded from PWA precaching.

The UI's browser explorer is behind the tenant setting `analytics.browser.enabled`, default off. The engine supports CSV, JSON, JSON Lines, NDJSON, and Parquet. DuckDB-Wasm runs the way its README documents for Vite: `AsyncDuckDB` drives DuckDB's own worker (there is no worker of ours), `selectBundle` chooses between the self-hosted MVP and EH bundles, and the page's files are registered as browser file handles, so DuckDB reads the `File` in slices instead of a copy in memory. CSV is read with `read_csv`, which is built in. JSON and Parquet (`read_json`, `read_parquet`) need DuckDB's official `json` and `parquet` extensions, which the browser wasm bundles do not link in (only the Node build does). They are **self-hosted**, as DuckDB-Wasm [documents](https://duckdb.org/docs/1.4/clients/wasm/extensions.html): the signed official files are committed under `apps/web/public/duckdb-extensions/v<duckdb version>/<platform>/<name>.duckdb_extension.wasm` (platforms `wasm_eh` and `wasm_mvp`; about 7.5 MB for all four, a browser fetches the two of its bundle), the engine sets `custom_extension_repository` to that same-origin folder (`BASE_URL` respected) before `LOAD json` / `LOAD parquet`, and DuckDB verifies each file's signature on LOAD, so unsigned extensions stay refused. Nothing is requested from `extensions.duckdb.org`, and the Content Security Policy needs no change (`connect-src 'self'`, `'wasm-unsafe-eval'`). The files are not precached by the PWA. `src/features/analytics/duckdb-extensions.json` holds the pinned DuckDB version and the SHA-256 of each file; `pnpm --filter @nestjs-monorepo-template/web duckdb:extensions` downloads what is missing and verifies the pins, `duckdb:extensions:check` verifies the committed files offline. When a duckdb-wasm update moves the DuckDB version (`SELECT version()`), the engine refuses to start and a unit test fails: change `duckdbVersion`, run `node apps/web/scripts/duckdb-extensions.mjs --record`, and commit the new files. The table is profiled with one `SUMMARIZE` statement (its min, max and distinct counts; the distinct counts are approximate) and one exact `count(*) - count(column)` statement for the null counts (SUMMARIZE's null percentage has two decimals, so one null in 30,000 rows reads zero). Query results reach the page as plain values: `SUM` and `AVG` are cast to `DOUBLE` (an integer `SUM` is a `HUGEINT`), and a top-level 64-bit integer inside JavaScript's safe range becomes a `number` (so integer columns can be grouped and charted), a larger one stays a `bigint`; nested values keep their Arrow form. `DECIMAL`/`HUGEINT` columns shown as-is (not aggregated) still arrive as Arrow objects. JSON keeps nested objects as structs and mixed-type columns as JSON text. The import is materialized in DuckDB's memory, and replacing a file, leaving the page, signing out, or changing user/tenant cancels the running query and terminates the worker. It does not persist data in OPFS. Query SQL is constructed internally from validated columns, escaped identifiers, and escaped literals; the page cannot submit SQL or file paths. After the extensions are loaded the engine sets `enable_external_access = false` with `allowed_paths` limited to the fixed virtual file names, turns auto-install and auto-load of extensions off, and sets `lock_configuration = true`, so no remote read or extension is possible. There is no file-size check of our own: nothing is copied into the JavaScript heap, but the browser's wasm memory still bounds what fits, and a file that does not fit fails to load. The PWA precache excludes `**/*duckdb*` so the optional engine does not inflate the offline bundle. The WASM engine is a separately versioned experiment on SQL 1.4.3; representative devices and less repetitive data still need measurement before broader use.

Before considering a production dependency, compare the existing `readRecords()` behavior for JSON and XLSX with the candidate engine on the same files, measure inside the deployment container, and verify graceful shutdown, native package availability for every published image architecture, temporary disk bounds, and any extensions needed for Parquet. A positive aggregate benchmark alone is insufficient: DuckDB must improve a real supported path while preserving these application contracts. The decision should be revisited only with those results.

The browser smoke test loads CSV, JSON, and Parquet, verifies filters and sorting, preserves JSON nulls and mixed values, cancels pending loads, and checks that no external requests occur. Run `CHROMIUM_PATH=/usr/bin/chromium node apps/web-e2e/scripts/analytics-smoke.mjs` against the web development server on port 5178. CI runs the same check with `ANALYTICS_BROWSER=chromium|firefox|webkit`. Large-file Firefox/WebKit cases and varying data shapes remain unmeasured.
