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
budgets remain unchanged. Optional analytics scripts have a separate 250 kB
Brotli budget; their self-hosted Wasm assets have a 50 MB uncompressed budget.
These engine assets are fetched on use and excluded from PWA precaching.

The UI's browser explorer is behind the tenant setting `analytics.browser.enabled`, default off. The engine supports CSV, JSON, JSON Lines, NDJSON, and Parquet. Parquet uses the lazy, self-hosted `parquet-wasm@0.9.0` decoder to produce Arrow IPC for DuckDB; it does not download a DuckDB extension. JSON uses an explicit Arrow schema: primitive columns keep their types and mixed or structured columns retain their values as JSON text. The import is materialized in the page's worker memory, and replacing a file, leaving the page, signing out, or changing user/tenant terminates the worker. It does not persist data in OPFS. Query SQL is constructed internally from validated columns, escaped identifiers, and escaped literals; the page cannot submit SQL or file paths. DuckDB auto-install and auto-load of extensions are disabled, and no remote extension fallback is used. The 1 GiB file-size check is a hard ceiling, not a promise that every browser/device can safely use that much memory. The PWA precache excludes `**/*duckdb*` and `**/*parquet*` so the optional engine does not inflate the offline bundle. The WASM engine is a separately versioned experiment on SQL 1.4.3; representative devices and less repetitive data still need measurement before broader use.

Before considering a production dependency, compare the existing `readRecords()` behavior for JSON and XLSX with the candidate engine on the same files, measure inside the deployment container, and verify graceful shutdown, native package availability for every published image architecture, temporary disk bounds, and any extensions needed for Parquet. A positive aggregate benchmark alone is insufficient: DuckDB must improve a real supported path while preserving these application contracts. The decision should be revisited only with those results.

The browser smoke test loads CSV, JSON, and Parquet, verifies filters and sorting, preserves JSON nulls and mixed values, cancels pending loads, and checks that no external requests occur. Run `CHROMIUM_PATH=/usr/bin/chromium node apps/web-e2e/scripts/analytics-smoke.mjs` against the web development server on port 5178. CI runs the same check with `ANALYTICS_BROWSER=chromium|firefox|webkit`. Large-file Firefox/WebKit cases and varying data shapes remain unmeasured.
