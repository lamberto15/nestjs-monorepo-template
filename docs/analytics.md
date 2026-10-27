# Analytics: the browser Data Explorer and backend feasibility

This page has two parts. **Part 1** is the decision record, threat model and
limitations of the **Data Explorer**, the web app's opt-in tool that profiles and
queries a data file inside the user's own browser (DuckDB-Wasm). **Part 2** is the
earlier **backend feasibility** study of DuckDB in the API and worker, which ended
in a no-go. The explorer does not change that decision: it never runs on the server.

## Part 1: The browser Data Explorer

### Decision record (ADR)

- **Status:** accepted; shipped behind a tenant flag, off by default. It began as
  issue #541 (browser exploration) and its engine rework is #736.
- **Context:** users have CSV, JSON or Parquet files (their own, or an export or a
  file they are about to import) and want to look at them: row counts, column
  types, nulls, ranges, a filtered or grouped view. Sending those files to the
  server for analysis would add a new data path, storage and a queue job.
- **Decision:** run [DuckDB-Wasm](https://duckdb.org/docs/1.4/clients/wasm/overview.html)
  in the browser. The file is read from the user's disk (or, for an export, from
  the bytes the user was already allowed to download), profiled and queried
  locally, and kept only in memory while the page is open. The API gets no new
  endpoint and receives nothing from the explorer.
- **Scope:** a single file at a time; formats CSV, JSON (array or nested), JSON
  Lines, NDJSON and Parquet; a column profile (type, nulls, approximate distinct
  count, min and max), one filter, one sort, a single group-by with a count or sum,
  a bounded page of at most 100 rows and a chart of a grouped result. Out of scope:
  joins across files, saving results, user-written SQL, remote files, persistence
  (nothing is stored in OPFS or IndexedDB), and any server-side analytics. The
  controls are changing; this page describes capabilities, not the layout.
- **Consequences:** the engine is a separately versioned dependency whose
  extensions we host ourselves (below), the page is excluded from offline
  caching, and the CSP has to allow WebAssembly compilation.

### The version pin

The engine is `@duckdb/duckdb-wasm` **1.32.0**, pinned exactly in
`apps/web/package.json`, which runs **DuckDB SQL v1.4.3**.

#541 asked for `@duckdb/duckdb-wasm@1.5.6`. **That version does not exist on npm.**
`1.5.6` is a DuckDB (and `@duckdb/node-api`) release number; DuckDB-Wasm is
versioned separately (1.32.0 here; checked against the npm registry on 2026-10-27,
where the newest tags are `1.33.1-dev*` builds). Do not read "DuckDB 1.5" and
"duckdb-wasm 1.5" as the same thing: the number that matters for compatibility is
the one `SELECT version()` returns, and the engine checks it at start-up.

**Support window.** DuckDB's [release calendar](https://duckdb.org/release_calendar)
(read on 2026-10-27) lists v1.4 as a Long-Term Support release whose support was
extended **until 17 November 2026**. v1.5 is supported until March 2027, and
**v2.0 LTS** was released on 2026-10-21 (supported until October 2027). So the
engine's SQL version is still supported on the date of writing but leaves its
support window within weeks. Moving to a newer DuckDB means a newer duckdb-wasm
that runs it, once DuckDB-Wasm publishes one, followed by the upgrade procedure
below. A Dependabot bump of `@duckdb/duckdb-wasm` that changes the DuckDB version
fails a unit test on purpose (see "Upgrading").

### Turning it on (opt-in)

The explorer is behind the tenant flag **`analytics.browser.enabled`**, declared
in `apps/api/src/platform/data-transfer/data-transfer.settings.ts`: scope
`tenant`, **default off**. An administrator turns it on per tenant under settings
([settings.md](settings.md)). While it is off:

- the navigation entry is hidden (`apps/web/src/features/analytics/nav.ts`), the
  `/analytics` route redirects home before any engine code is requested, and the
  "Open in Data Explorer" (exports) and "profile locally" (import) actions do not
  appear;
- turning the flag off while a file is open terminates the engine and clears the
  page on the spot.

The flag gates the **UI only**. The explorer reads no tenant data from the API on
its own, so there is nothing for the API to refuse; the files it opens come from
the user's disk or from the existing, permission-checked export download.

### Where the data comes from

1. **A file the user picks** with the browser's file chooser. It is never uploaded.
2. **A completed export** (CSV or JSON): "Open in Data Explorer" on the transfer
   status (`apps/web/src/features/transfer/transfer-status.tsx`), and the account
   export for the user's own data. Only after the user presses the open button does
   the page ask the API for a **fresh** signed link (`freshExportFile` in
   `apps/web/src/features/transfer/api.ts`), download the file into a `Blob` and
   hand it to the engine. The file is exactly what the user could already download.
3. **A file chosen for import** ("profile locally" on the import page), so the
   user can inspect it before uploading. It is passed through a one-use,
   memory-only handoff (`apps/web/src/features/analytics/handoff.ts`) together with
   the importer's expected column names. The handoff is discarded after 30 seconds
   if unused, and cleared when the signed-in user or tenant changes and when the
   route redirects because the flag is off.

**Local check on the import page.** With the flag on, choosing a CSV or JSON file
on the import page also starts a read-only check against the importer's columns
from `GET /v1/data` (`apps/web/src/features/transfer/local-check.tsx`; the
comparison is the pure `import-profile.ts`). The engine loads lazily, only then.
It reports, under "Local check (not authoritative)": required columns the file
lacks, file columns the import does not take, columns whose detected type
contradicts the catalog's (values the server would not take as the catalog's
`number`, `boolean`, `date` or `datetime`, counted with SQL that mirrors the
server's rules: a CSV is read as text, so `31/01/2024` is not a date and `maybe`
is not a boolean; or, in JSON, a clearly different type), repeated values of the
chosen match key (compared trimmed, blank keys ignored), headers the file
repeats (the server keeps the last), and required columns with at least 20%
empty values (`NULL_HEAVY_SHARE`). The match key is looked up in the file's
header, not the catalog's columns (a notes import matches on `id` or `number`).
A `.json` file that is not an array of objects (JSON Lines) is reported as
refused, as the server refuses it; the data explorer still reads JSON Lines.
Excel files are skipped with a note. It is informational: the server's `dryRun` stays the
authority, and the import is never blocked or changed by it. Leaving the page,
removing or replacing the file, turning the flag off, changing user or tenant, or
Cancel ends the engine or disposes the dataset.

Usability and failure notes for the transfer integration: an expired or already
removed export shows the generic error (the signed link lasts 30 minutes, and a
fresh one is requested on each open); a failed download or an unreadable file shows
a generic error, not a partial table; an export is held in the tab's memory as a
`Blob` before DuckDB reads it, so a very large export costs more than a file picked
from disk (which DuckDB reads in slices, without a copy).

### Threat model

| Concern                  | What is true                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What reaches the browser | Only the file the user chose, or an export they were authorized to download. The explorer adds no API route and sends nothing back: no file content, column names, queries or results are transmitted.                                                                                                                                                                                                                                                        |
| Snapshot, not permission | A file released to the browser is an **authorized snapshot**. Having it open is not evidence that the user may still see that data: after a role change, revocation or deactivation, a copy already downloaded or opened stays readable until the tab closes, exactly like a downloaded export. The explorer never rechecks permissions per row. Revocation is enforced on the API (no new exports), not on bytes already released.                           |
| Remote reads             | None. `enable_external_access = false` and `allowed_paths` limited to five fixed virtual file names, so `read_csv('https://…')`, `httpfs`, other files and ATTACH of remote databases are refused. The page cannot submit SQL or file paths: queries are built internally from validated columns, escaped identifiers and escaped literals (`apps/web/src/features/analytics/query.ts`).                                                                      |
| Extensions               | Only the official `json` and `parquet` extensions, **self-hosted** on the app's origin and loaded before the lockdown. DuckDB verifies each extension's signature on `LOAD` (signature checking stays on), the files are pinned by SHA-256, and auto-install and auto-load are switched off afterwards. Nothing is requested from `extensions.duckdb.org`.                                                                                                    |
| Configuration            | The lockdown order in `apps/web/src/features/analytics/engine.ts` is: check `SELECT version()` against the pin, set `custom_extension_repository` (same origin), `LOAD json`, `LOAD parquet`, turn auto-install and auto-load off, set `allowed_paths`, `enable_external_access = false`, then `lock_configuration = true`, so a query cannot undo it.                                                                                                        |
| Content Security Policy  | `caddy/Caddyfile` and the Helm `deploy/helm/app/templates/web-configmap.yaml` send `script-src 'self' 'wasm-unsafe-eval'` (WebAssembly compilation only; `unsafe-eval` stays blocked), `worker-src 'self'` and `connect-src 'self'` plus the operator-configured file-store origins (`WEB_FILES_ORIGINS`, for downloading exports). Engine, worker and extensions are all first-party files, so the policy needed no relaxation beyond `wasm-unsafe-eval`.    |
| Persistence              | In memory only: no OPFS, IndexedDB or localStorage copy of the data. The engine and extensions are not in the PWA precache (`apps/web/vite.config.ts`, `globIgnores`), so offline mode neither stores them nor the data. The browser may still keep a downloaded export `Blob` or its HTTP cache entry for its own reasons.                                                                                                                                   |
| Logout                   | Signing out clears the session (`apps/web/src/lib/sign-out.ts`), the signed-in identity becomes empty, and the page's identity effect terminates the engine and drops the open dataset; navigating to the sign-in page unmounts the page, which terminates it again. Other tabs end their sessions when the sign-out is announced, which unmounts the page there too. Termination cancels the running query and ends DuckDB's worker, which frees its memory. |
| Tenant or user switch    | The page watches `user.id:tenant.id`. When it changes, the engine is terminated, the file and results are cleared, and any in-flight export lookup that finishes later is ignored. A pending handoff is cleared by the app layout. A file the user must open again in the new tenant is a fresh selection.                                                                                                                                                    |
| Leaving the page         | Leaving the route unmounts the page, which terminates the engine. A load that was still starting is cancelled and its engine ended once it is up. Replacing a file starts a fresh engine, because wasm memory never shrinks.                                                                                                                                                                                                                                  |
| Residual risks           | A compromised page or a malicious browser extension can read the user's files and memory regardless of the explorer. The explorer trusts the chosen file's bytes only as data; hostile Parquet or JSON is parsed by DuckDB inside its worker with external access disabled. Leaving the tab open after stepping away is the user's risk: the session idle warning and expiry apply, and sign-out or a tenant switch terminate the engine.                     |

The termination paths are covered by unit tests in
`apps/web/src/features/analytics/analytics.test.tsx` (flag turned off, identity
change, export lookup racing a tenant change, unmount) and `engine.test.ts`
(lockdown order, cancellation, fresh engine per import). There is no test that
drives a real sign-out through the sign-out hook; the identity change it causes is
what is tested.

### Limitations users will see

- **Memory.** DuckDB-Wasm is bounded by the browser's WebAssembly memory. The
  explorer has no file-size check of its own, nothing is copied into the JavaScript
  heap, but the table is materialized in DuckDB's memory, so a file that does not
  fit fails to load with a generic error. There is **no promise for multi-GB files**,
  . A tab may be killed by the browser
  under memory pressure.
- **Approximate distinct counts.** "Distinct values" is SUMMARIZE's `approx_unique`
  (HyperLogLog), not exact. Null counts are exact (a separate statement).
- **Nested JSON** is kept as structs and lists (mixed-type columns as JSON text),
  so deeply nested or inconsistent documents appear in DuckDB's inferred types.
- **Large and exact numbers.** Query results arrive as plain values: `SUM` and
  `AVG` are cast to `DOUBLE`; a 64-bit integer inside JavaScript's safe range
  becomes a number, a larger one stays a `bigint`. `HUGEINT` and `DECIMAL` columns
  shown as-is arrive as Arrow objects, and their min and max cannot be charted.
  Casting to `DOUBLE` loses exactness above 2^53.
- **Error messages.** For CSV the DuckDB error text is passed through unchanged; for
  JSON and Parquet a fixed "malformed or unsupported" message replaces it. The
  page itself shows one generic error.
- **Formats.** CSV, JSON, JSON Lines, NDJSON and Parquet only, one file at a time
  (`.csv`, `.json`, `.jsonl`, `.ndjson`, `.parquet`). Every format is detected by
  extension, and sample-based type inference reads the whole file (`sample_size = -1`).
- **Exports.** Only completed CSV and JSON exports can be opened from the transfer
  status, and only while the signed link can be refreshed.
- **Size of the import is unchanged.** Exploring a file locally does not raise the
  server's import limits (`dataTransfer.importMaxMiB`, default 50 MiB, and
  `importMaxRows`; [import-limits.md](import-limits.md)). A file that explores
  fine may still be refused by the importer.
- **Browser support.** CI runs the same smoke test in Chromium, Firefox and WebKit,
  but only against small fixtures; large-file behavior was measured on headless
  Chromium alone and varies by device.

### Engine, bundles and size

`apps/web/src/features/analytics/engine.ts` follows DuckDB-Wasm's documented Vite
setup: one `AsyncDuckDB` drives DuckDB's own worker (the app has no worker of its
own), and `selectBundle` picks the self-hosted MVP or EH build by browser
features. The package, workers and wasm are loaded with a **dynamic `import()` only
when the page opens**, so none of it is in the entry chunk. Files are registered as
browser file handles (`BROWSER_FILEREADER`), so DuckDB reads the `File` in slices;
CSV uses `read_csv`, JSON `read_json`, Parquet `read_parquet`; the file is
materialized once into a temporary table and then released. Profiling is one
`SUMMARIZE` statement plus one exact null-count statement. A new import always
starts a fresh engine.

Size budgets (`apps/web/.size-limit.json`, enforced in CI): the existing
application scripts stay at 1.1 MB Brotli; the optional engine scripts have a
separate 360 kB Brotli budget (343.55 kB measured when set), the engine wasm an
80 MB uncompressed budget (73.61 MB measured for both bundles; a browser fetches
one) and the self-hosted extensions 8 MB (about 7.5 MB for all four; a browser
fetches two). These are fetched on use and excluded from PWA precaching.

### Self-hosted extensions and upgrading

The wasm bundles do not link in `json` and `parquet`, and DuckDB-Wasm
[documents](https://duckdb.org/docs/1.4/clients/wasm/extensions.html) pointing
`custom_extension_repository` at your own copy. The signed official files are
committed under
`apps/web/public/duckdb-extensions/v<duckdb version>/{wasm_eh,wasm_mvp}/{json,parquet}.duckdb_extension.wasm`
(currently `v1.4.3`). `apps/web/src/features/analytics/duckdb-extensions.json`
holds the DuckDB version and the SHA-256 of each file; the script
`apps/web/scripts/duckdb-extensions.mjs` manages them:

```bash
pnpm --filter @nestjs-monorepo-template/web duckdb:extensions         # download what is missing, verify the pins
pnpm --filter @nestjs-monorepo-template/web duckdb:extensions:check   # verify the committed files offline
node apps/web/scripts/duckdb-extensions.mjs --record                  # download everything, rewrite the pinned hashes
```

**Upgrading `@duckdb/duckdb-wasm`.** If the new package runs a different DuckDB
version, two things fail on purpose: `duckdb-extensions.test.ts` (it asks the
package's Node build for its version) and the engine's start-up check. Then:

1. Bump the package in `apps/web/package.json` (exact version, never a range).
2. Change `duckdbVersion` in `duckdb-extensions.json`.
3. Run the script with `--record`, review the diff, commit the new files and
   remove the old `v<version>` folder.
4. Check the size budgets, and run the unit tests and the browser smoke test.

### Tests

- Unit tests in `apps/web/src/features/analytics/*.test.ts(x)`: SQL generation,
  Arrow conversion, the engine's lockdown and lifecycle, the handoff, the page.
- The browser smoke `apps/web-e2e/scripts/analytics-smoke.mjs` loads CSV, JSON and
  Parquet in a real browser, checks filters, sorting, JSON nulls and mixed values,
  cancellation, and **asserts that no request leaves the page's origin**. Chromium
  runs in the `e2e-web` job; Firefox and WebKit in the `analytics-smoke` job of
  `.github/workflows/web.yml`. Locally: `CHROMIUM_PATH=/usr/bin/chromium node apps/web-e2e/scripts/analytics-smoke.mjs`
  against the web development server on port 5178 (`ANALYTICS_BROWSER=chromium|firefox|webkit`).

### Measurements

A single headless Chromium probe loaded synthetic CSV files of 50,200,014,
251,000,014 and 502,000,014 bytes and returned a 100-row query in 2.40, 5.51 and
7.50 seconds. Each case used a fresh browser, a numeric group column and a
repetitive 1,000-character text column (50,000 / 250,000 / 500,000 rows). No page
error or crash occurred. RSS was not sampled; these low-cardinality fixtures do
not establish memory limits or performance for typical data, and large-file
Firefox and WebKit cases are unmeasured. Representative devices and less
repetitive data still need measurement before broader promises.

## Part 2: Backend feasibility

### Decision

**Do not add DuckDB to the production API or worker yet.** The current platform
analytics job writes a small, daily, anonymized aggregate table in PostgreSQL; it
has no analytical query surface that needs a second engine. The import path is a
separate question: JSON and XLSX parsing happen in the data-transfer worker, and
there is no evidence yet that DuckDB improves the supported import behavior enough
to justify a native runtime dependency.

This is a no-go for a production dependency pending measurements and a
compatibility review. It is not a claim that DuckDB is slower or unsuitable. The
import path stays on the library-based readers (ExcelJS loads a workbook whole
under the size limit, CSV streams); an earlier worker-side rewrite with a DuckDB
probe was reverted (#695), and no DuckDB measurements of the worker import path are
kept here.

### Engine and API checked

DuckDB's official Node bindings documentation describes `@duckdb/node-api` as the
Promise based API backed by the C API, and lists Linux x64/arm64 glibc and musl,
macOS, and Windows packages. The published `1.5` line checked for this work reaches
`1.5.6-r.2`; the package's `lts-v1.4` tag is `1.4.5-r.1`, and its moving `latest`
tag is already `2.0.0-r.1`. Pin the explicit release in any reproduction; never use
`latest` for this comparison. DuckDB releases and native prebuilds must match the
deployment's OS and libc. (This `1.5.6` is the Node bindings' version; the browser
package is versioned separately, see Part 1.)

- [DuckDB Node bindings README](https://github.com/duckdb/duckdb-node-neo/blob/main/api/pkgs/%40duckdb/node-api/README.md)
- [DuckDB Node bindings package](https://www.npmjs.com/package/%40duckdb/node-api)
- [DuckDB releases](https://github.com/duckdb/duckdb/releases)
- [DuckDB WASM package](https://www.npmjs.com/package/@duckdb/duckdb-wasm)

### What would reopen it

Before considering a production dependency, compare the existing `readRecords()`
behavior for JSON and XLSX with the candidate engine on the same files, measure
inside the deployment container, and verify graceful shutdown, native package
availability for every published image architecture, temporary disk bounds, and any
extensions needed for Parquet. A positive aggregate benchmark alone is
insufficient: DuckDB must improve a real supported path while preserving these
application contracts. The decision should be revisited only with those results.
