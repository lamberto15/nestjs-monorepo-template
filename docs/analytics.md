# Analytics engine feasibility

## Decision

**Do not add DuckDB to the production API or worker yet.** The current platform analytics job writes a small, daily, anonymized aggregate table in PostgreSQL; it has no analytical query surface that needs a second engine. The import path is a separate question: JSON and XLSX parsing happen in the data-transfer worker, and there is no evidence yet that DuckDB improves the supported import behavior enough to justify a native runtime dependency.

This is a no-go for a production dependency pending measurements and a compatibility review. It is not a claim that DuckDB is slower or unsuitable. The optional probe below gives a reproducible starting point; its synthetic measurements do not substitute for representative uploads or browser testing.

## Engine and API checked

DuckDB's official Node bindings documentation describes `@duckdb/node-api` as the Promise based API backed by the C API, and lists Linux x64/arm64 glibc and musl, macOS, and Windows packages. The published `1.5` line checked for this work reaches `1.5.6-r.2`; the package's `lts-v1.4` tag is `1.4.5-r.1`, and its moving `latest` tag is already `2.0.0-r.1`. Pin the explicit 1.5 release in any reproduction; never use `latest` for this comparison. DuckDB releases and native prebuilds must match the deployment's OS and libc.

- [DuckDB Node bindings README](https://github.com/duckdb/duckdb-node-neo/blob/main/api/pkgs/%40duckdb/node-api/README.md)
- [DuckDB Node bindings package](https://www.npmjs.com/package/%40duckdb/node-api)
- [DuckDB releases](https://github.com/duckdb/duckdb/releases)
- [DuckDB WASM package](https://www.npmjs.com/package/@duckdb/duckdb-wasm)

## Reproduce the local probe

The optional native module is installed outside the repository so it cannot enter a production manifest or lockfile. The API build is used for the existing reader; use the same checkout and machine for both reader revisions. The published browser package checked here is `@duckdb/duckdb-wasm@1.32.0`, whose runtime reports DuckDB SQL `v1.4.3`; it does not provide a browser comparison on SQL 1.5. UI unit tests use mocked API responses. No browser file-size benchmark was available for 50/250/500 MiB files, so no browser performance result is claimed.

```bash
tmpdir="$(mktemp -d)"
pnpm --dir "$tmpdir" init
pnpm --dir "$tmpdir" add --save-exact @duckdb/node-api@1.5.6-r.2
pnpm --filter @nestjs-monorepo-template/api build
DUCKDB_NODE_API="$tmpdir/node_modules/@duckdb/node-api/lib/index.js" \
  TRANSFER_READER_ENTRY="$PWD/apps/api/dist/platform/data-transfer/formats.js" \
  TRANSFER_SPOOL_ENTRY="$PWD/apps/api/dist/platform/data-transfer/import-spool.js" \
  BENCH_SIZES_MB=5,25 BENCH_TWO_PASS=1 BENCH_SPOOL=1 \
  node tools/benchmarks/duckdb-feasibility.mjs
```

Set `BENCH_SIZES_MB=5,25,50` to select JSON target sizes (the default), and `BENCH_KEEP_FILES=1` to keep generated inputs, the database, and Parquet outputs for inspection. JSON and XLSX sizes are reported as generated; XLSX compression means its file is smaller than the JSON file for the same rows. Each parser runs in a fresh child process; the report includes elapsed time, throughput, OS peak RSS, CPU time, Parquet and database bytes, and total temporary disk. `BENCH_TWO_PASS=1` also measures `inspectRecords()` followed by `readRecords()`, which reflects the two parser passes in the worker before it validates and writes rows. This still excludes schema checks, database writes, audit, progress reporting, and the full queue job. Runs are serial; they do not measure two-job concurrency or cgroup memory. Record host/container CPU and memory limits alongside shared results.

The JSON and XLSX baseline cases reproduce the existing full-buffer `JSON.parse` and ExcelJS whole-workbook read. The spooled modes run the current `spoolImportRecords()` source parse/normalization/write followed by `readImportSpool()` replay in one fresh child process. They report spool bytes as well as peak RSS. They do not include application schema validation, importer writes, duplicate matching, progress, or queue overhead. The DuckDB case reads JSON, groups, joins, and writes Parquet; XLSX stays on ExcelJS because DuckDB has no core XLSX reader. Baseline and revised readers use the same files. Keep the generated files identical between runs, do a warm-up, then record at least three runs and report the median. Record the exact revision and host/container limits with results.

For large JSON-only cases, set `BENCH_JSON_ONLY=1` to skip XLSX generation and DuckDB while retaining streaming JSON fixture generation. For example:

```bash
BENCH_JSON_ONLY=1 BENCH_SIZES_MB=50,100 BENCH_TWO_PASS=1 BENCH_SPOOL=1 \
  TRANSFER_READER_ENTRY="$PWD/apps/api/dist/platform/data-transfer/formats.js" \
  TRANSFER_SPOOL_ENTRY="$PWD/apps/api/dist/platform/data-transfer/import-spool.js" \
  node tools/benchmarks/duckdb-feasibility.mjs
```

## Evidence and open checks

The worker probe does not prove compatibility with field validation, date handling, malformed input errors, limits, or import batching. A single synthetic run is exploratory; repeat each case at least three times for a median before treating small differences as meaningful. Browser 50/250/500 MiB and two-job container concurrency remain unmeasured.

### Worker probe (one synthetic run)

The probe ran on Node `v24.19.0` with `@duckdb/node-api@1.5.6-r.2`. JSON and XLSX were generated from the same rows using a streaming XLSX writer. At the 5 MiB target there were 44,058 rows (JSON 5.45 MiB, XLSX 1.56 MiB); at 25 MiB there were 220,290 rows (JSON 27.55 MiB, XLSX 7.84 MiB). The host/container CPU limits were not captured. These are single-run measurements, not medians:

| Input target | Path | Elapsed | CPU | Peak RSS | Throughput |
| --- | --- | ---: | ---: | ---: | ---: |
| 5 MiB | JSON baseline full-buffer parse | 64 ms | 59 ms | 78 MiB | 85.0 MiB/s |
| 5 MiB | JSON revised one pass | 761 ms | 868 ms | 114 MiB | 7.2 MiB/s |
| 5 MiB | JSON revised inspect + process | 1,967 ms | 1,806 ms | 191 MiB | 2.8 MiB/s |
| 5 MiB | JSON final spool + replay | 984 ms | 1,393 ms | 198 MiB | 5.5 MiB/s |
| 5 MiB | XLSX ExcelJS baseline | 2,629 ms | 2,107 ms | 296 MiB | 0.60 MiB/s |
| 5 MiB | XLSX revised one pass | 4,114 ms | 2,624 ms | 117 MiB | 0.38 MiB/s |
| 5 MiB | XLSX revised inspect + process | 3,825 ms | 3,769 ms | 126 MiB | 0.41 MiB/s |
| 5 MiB | XLSX final spool + replay | 1,960 ms | 2,319 ms | 140 MiB | 0.80 MiB/s |
| 25 MiB | JSON baseline full-buffer parse | 157 ms | 197 ms | 185 MiB | 175.3 MiB/s |
| 25 MiB | JSON revised one pass | 1,828 ms | 2,155 ms | 108 MiB | 15.1 MiB/s |
| 25 MiB | JSON revised inspect + process | 5,470 ms | 6,382 ms | 269 MiB | 5.0 MiB/s |
| 25 MiB | JSON final spool + replay | 3,505 ms | 4,271 ms | 328 MiB | 7.9 MiB/s |
| 25 MiB | XLSX ExcelJS baseline | 3,819 ms | 5,343 ms | 931 MiB | 2.05 MiB/s |
| 25 MiB | XLSX revised one pass | 5,757 ms | 6,064 ms | 188 MiB | 1.36 MiB/s |
| 25 MiB | XLSX revised inspect + process | 12,254 ms | 12,878 ms | 237 MiB | 0.64 MiB/s |
| 25 MiB | XLSX final spool + replay | 16,071 ms | 10,007 ms | 245 MiB | 0.49 MiB/s |

The final spool output was 8,309,202 bytes (7.92 MiB) for the 5 MiB JSON target and 8,744,370 bytes (8.34 MiB) for its 1.56 MiB XLSX. At the 25 MiB target it was 41,891,809 bytes (39.95 MiB) for JSON and 44,298,145 bytes (42.25 MiB) for its 7.84 MiB XLSX. Those are spool file sizes, not a measured peak for all scratch files. The harness's total generated temporary disk at the end of the run, including fixtures, DuckDB files, and Parquet outputs for both sizes, was 49.75 MiB.

On these inputs, final JSON spooling took less time than the earlier two-pass streaming flow at both sizes, but at 25 MiB its 328 MiB peak RSS was higher than both two-pass streaming (269 MiB), one-pass streaming (108 MiB), and the full-buffer `JSON.parse` baseline (185 MiB); it was also far slower than the baseline. Final XLSX spooling lowered peak RSS versus ExcelJS's full-workbook baseline at both sizes (140 vs 296 MiB and 245 vs 931 MiB), and was faster at 5 MiB. At 25 MiB it took about 4.2 times as long as the baseline. Spooling therefore trades temporary disk and time for lower peak memory most clearly on the 25 MiB XLSX input; it does not show a JSON memory win here. The generated Parquet transform (DuckDB 1.5.6, JSON read + grouping + join + Parquet write) took 213 ms at 5 MiB (241 ms CPU, 143 MiB peak RSS, 25.5 MiB/s) and 2,167 ms at 25 MiB (1,136 ms CPU, 344 MiB peak RSS, 12.7 MiB/s). Output files were 191 KB and 932 KB, temporary DuckDB files were 1.59 MiB and 4.99 MiB. These aggregate queries are not a replacement for import parsing or application validation.

### Large JSON scaling probe (one synthetic run)

A JSON-only run generated inputs incrementally, without an XLSX workbook or a retained row array. The nominal 50 and 100 MiB targets produced 55.31 and 110.84 MiB files (440,579 and 881,157 rows). Peak RSS stayed similar for final spooling as input doubled (330.1 to 324.8 MiB), while the full-buffer `JSON.parse` baseline rose from 316.6 to 493.6 MiB. At 100 MiB the spool path peaked 34% below that baseline, but took 12.6 seconds versus 0.7 seconds. The one-pass streaming reader at 100 MiB took 5.6 seconds and peaked at 129.4 MiB, so final spooling did not beat that path on time or memory. The spool path took 6.9 seconds at 50 MiB and 12.6 seconds at 100 MiB; its spool files were 83,963,792 bytes (80.07 MiB) and 168,107,722 bytes (160.32 MiB). Source plus spool occupied about 135.4 and 271.2 MiB while both files existed; no other scratch files were produced for JSON. Total generated source fixture disk was 166.16 MiB. This single run supports bounded spool memory over this size range, not a general memory or performance win; the 25 MiB JSON result above remains a counterexample to a memory benefit at smaller sizes.

There are no 50 MiB results. An earlier fixture generator retained the full ExcelJS workbook in memory; generation reached 2.5 GiB RSS while the container was at 6.9 of its 8 GiB memory limit, so that run was stopped before parsing. The committed harness now streams fixture generation, but the 50 MiB case was not rerun. There are also no browser 50/250/500 MiB results and no two-job concurrency results.

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

The UI's browser explorer is behind the tenant setting `analytics.browser.enabled`, default off. The engine supports CSV, JSON, JSON Lines, NDJSON, and Parquet. Parquet uses the lazy, self-hosted `parquet-wasm@0.9.0` decoder to produce Arrow IPC for DuckDB; it does not download a DuckDB extension. JSON uses an explicit Arrow schema: primitive columns keep their types and mixed or structured columns retain their values as JSON text. The import is materialized in the page's worker memory, and replacing a file, leaving the page, signing out, or changing user/tenant terminates the worker. It does not persist data in OPFS. Query SQL is constructed internally from validated columns, escaped identifiers, and escaped literals; the page cannot submit SQL or file paths. DuckDB auto-install and auto-load of extensions are disabled, and no remote extension fallback is used. The 1 GiB file-size check is a hard ceiling, not a promise that every browser/device can safely use that much memory. The PWA precache excludes `**/*duckdb*` and `**/*parquet*` so the optional engine does not inflate the offline bundle. The WASM engine is a separately versioned experiment on SQL 1.4.3; file import, memory, and performance still need real-browser measurements before broader use.

Before considering a production dependency, compare the existing and revised `readRecords()` behavior for JSON and XLSX with the same files, measure inside the deployment container, and verify graceful shutdown, native package availability for every published image architecture, temporary disk bounds, and any extensions needed for Parquet. A positive aggregate benchmark alone is insufficient: DuckDB must improve a real supported path while preserving these application contracts. The decision should be revisited only with those results.

The browser smoke test loads CSV, JSON, and Parquet, verifies filters and sorting, preserves JSON nulls and mixed values, cancels pending loads, and checks that no external requests occur. Run `CHROMIUM_PATH=/usr/bin/chromium node apps/web-e2e/scripts/analytics-smoke.mjs` against the web development server on port 5178. CI runs the same check with `ANALYTICS_BROWSER=chromium|firefox|webkit`. The larger browser file matrix remains unmeasured.
