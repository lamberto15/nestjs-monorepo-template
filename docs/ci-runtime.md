# CI runtime and runner usage

The targets: an ordinary pull request validated in about five minutes, a
handful of runners per pull request, and every check that protects a merge
kept. Runners are the scarce resource. The repository is public, so minutes
are free and runners are 4-vCPU, but every job counts against the plan's 20
concurrent jobs, which several open pull requests share. Measurements, not
guesses, decide the layout. The audit behind it: issue
[#681](https://github.com/lamberto15/nestjs-monorepo-template/issues/681).

## The rules the workflow follows

- **A job of its own only when it needs one:** services (PostgreSQL, Redis),
  a browser, Docker, or minutes that would lengthen the critical path. Quick
  checks run as steps of a job that has already installed the workspace:
  `check` runs the API's and the packages' unit tests, the OpenAPI diff, the
  bundle budget, Storybook, `packages/ui`'s typecheck, the Prettier check
  (`pnpm format:check`), the check that the router's generator leaves the
  committed `routeTree.gen.ts` unchanged, and the notes-removal guard. `e2e-web` runs the
  Chromium browser tests and the instrumented e2e sixth. `image` runs the
  hardened stack. `stack-config` runs the Compose and Swarm renders.
- **No artifact between jobs that could share a runner:** `image` used to
  hand its tarball to `hardened-stack`, and the download alone took up to
  110 s. An image is exported only when the run publishes it.
- **Write caches where they are read:** pull requests read the BuildKit
  caches that `main` and the nightly run write, and never write them. A pull
  request's cache serves only its own later pushes, and its export cost 40 s
  (API image), 110 s (Caddy) and 290 s (backup, through
  `compose.ci-cache.yaml`). Gotenberg's pull-request builds key their Debian
  upgrade by day, so a pull request's later pushes reuse it.
- **Selective, not exhaustive, on a pull request:** `changes`
  (`tools/ci/changes.mjs`) routes by path. The gate (`ci-gate`) requires
  exactly the classified jobs, so a skipped job never leaves a check pending.
  `tools/ci/changes.test.mjs` pins the jobs an ordinary API, web or docs
  pull request runs: a new job there is a runner every such pull request
  waits for.
- **Comprehensive where it costs no pull request:** the nightly run (and
  tags, manual runs and changes that classify as `full`) adds
  `template-without-notes` (six shards) and the images. `web.yml` adds
  Lighthouse.
- **Flaky is a bug, not a retry:** Playwright's one CI retry stays, but a
  retried attempt's trace is uploaded (`playwright-report`), so a flake
  leaves evidence (one such trace explained a flake of
  [#683](https://github.com/lamberto15/nestjs-monorepo-template/issues/683)).

## Jobs per pull request

| Pull request touches | CI / CD jobs (runners) | Other workflows |
| --- | --- | --- |
| the API (`apps/api/src`) | `changes`, then `check`, `e2e` ×2, `e2e-web`, `security`, `image` | Typed client, commit messages |
| the web app (`apps/web/src`) | `changes`, then `check`, `unit-web`, `e2e-web`, `security`, `caddy-image` | commit messages |
| documentation only | `changes` | Documentation, commit messages |

Before #681 an API pull request ran 14 CI / CD jobs at the median and a web
one 9, plus 5 more in `web.yml`. CodeQL's default setup adds three jobs to
every pull request; it is a repository setting, not a workflow here.

## Measurements

Every number comes from the Actions REST API (`jobs` of each run: created,
started and completed times). Runner-minutes sum active job durations, not
GitHub's rounded billing units. Queue time is a job's `created_at` to its
`started_at`. Collect any run with:

```bash
node tools/ci/metrics.mjs collect <owner/repo> <run-id> /tmp/run.json
```

### Before (2026-10-24 to 2026-10-26, last 400 pull-request runs)

Successful CI / CD runs, grouped by what they ran:

| Shape | Runs | Wall p50 (max) | Runner-min p50 | Jobs p50 | Peak concurrent jobs p50 (max) |
| --- | --- | --- | --- | --- | --- |
| API | 3 | 8.7 (9.6) min | 31.1 | 14 | 8 (8) |
| web | 9 | 5.2 (6.9) min | 13.9 | 9 | 6 (6) |
| API + web | 5 | 8.5 (12.3) min | 42.3 | 17 | 11 (13) |
| API + web + stack | 2 | 6.5 (17.9) min | 36.2 | 21 | 11 (13) |
| all 27 | 27 | 6.2 min (p95 12.3) | 23.9 (p95 46) | 12 | 7 (13) |

Per push, across every workflow: 16.7 jobs on average, a peak of 9.2
concurrent (p95 17, max 19), and 30.5 runner-minutes. Across the
repository, PR jobs peaked at 20 concurrent, the plan's cap. Queueing was
mostly short (p95 24 s) with a 12.4-minute tail.

Where the time went:

- **API:** `image` (4.0 min) then `hardened-stack` (3.5 min), with the
  image's tarball uploaded and downloaded between them (p95 110 s). The
  e2e shards, split by file count, held 1006 s and 535 s of test time.
- **Web:** `caddy-image` (4.5 min, p95 7.2): 38.6 s of build, ~96 s pulling
  the cached install layer and ~110 s exporting the cache. Then
  `unit (web whole)` (4.2 min).
- **Gotenberg:** `APT_REFRESH=run_id` rebuilt its Debian upgrade on every
  pull request (3–7 min).

Failures, by cause: `template-without-notes` broke on `main`/nightly in 4 of
6 runs (references to the notes feature outside it, which no pull request
checked; now `check`'s last step). `session-identity.spec.ts` passed only on
retry in 3 of 33 green `e2e-web` runs (a race in the test; #683). The unit
failures on two feature branches were never re-run on the same commit and
read as work in progress. The Trivy failures on `main` were new upstream
advisories: a real signal, kept.

### After (#682, this layout)

The pull request's own runs touch the API, the web app, the stack, the
generator and CI, the heaviest shape (compare with "API + web + stack"):

| Run | Wall | Runner-min | Jobs | Peak concurrent | Max queue |
| --- | --- | --- | --- | --- | --- |
| 40369590382, first push (cold Turbo and backup caches) | 11.3 min | 40.4 | 13 | 11 | 2 s |
| 40371891394, after the fixes below (warm Turbo cache) | 5.8 min | 25.4 | 13 | 11 | 3 s |
| 40373581160, the same jobs one push later | 7.3 min (+2.2 waiting for the run it replaced to cancel) | | 13 | | 13 s |
| 40374480913, a docs commit later | 12.0 min, 7.1 of it apt (below) | | 13 | | 2 s |

The first run measured two mistakes, fixed before the second. An
instrumented e2e half-suite cost +20% test time and 8% setup (358 s against
250 s): the instrumentation now runs on a sixth, in `e2e-web`, as before.
The backup cache's export from `compose.ci-cache.yaml` took 291 s: the
overlay now only reads it.

The same tests ran 30% slower on the third run's runners (the heavier shard
341 s against 259 s, the instrumented sixth 151 s against 101 s): a single
run is a sample, not a figure. Job times on the second run: `e2e (1/2)` 5.3 min (its tests 259 s, the
critical path), `e2e (2/2)` 4.4, `e2e-web` 4.2 (browser tests 52 s, the
instrumented sixth 103 s), `image` with the hardened stack 3.0, `caddy-image`
2.3, `feature-smoke` 3.0. With a warm Turbo cache, `check` and `unit (web)`
replayed (1.2 and 0.6 min). Cold, they took 3.2 and 4.8 min on the first run.

What that gives the ordinary shapes, from those measured job times (they
were not run separately, so they are estimates):

- **API:** `changes` (10 s) and the heavier e2e shard (5.1–6.9 min over
  three runs): about 5.5–7 min, against 8.7 at the median. 6 CI / CD
  runners, against 14 jobs and a peak of 8.
- **Web:** `changes` and `unit (web)` cold (4.8 min): about 5 min, against
  5.2 at the median and 6.9 at most. `caddy-image` (2.3–2.6 min) is off the
  critical path. 6 CI / CD runners and no `web.yml` jobs, against 9 + 5.

The Playwright tail: `playwright install-deps` (apt, from the runner's
Ubuntu mirror) took 20 s at the median and 47 s at p95 over 97 runs, but 6–8
min in 3 of them (`Fetched 25.9 MB in 6min 56s (62.4 kB/s)`), the critical
path when it happened. `e2e-web` now runs in the runner's own Google Chrome
(`E2E_BROWSER_CHANNEL=chrome`, Playwright's `channel: 'chrome'`): no
download, no apt. The cost: the browser is the runner image's Chrome stable
(its version is in the job's log), not the Chromium pinned with
`@playwright/test`. Playwright's container image was the other way out,
declined: the services would move from `localhost` to their hostnames, a pull
of over a gigabyte each run, and a tag Dependabot doesn't keep in step with
`@playwright/test`.

Still to measure: these shapes on real pull requests after the merge, and
a cold Turbo cache on the second layout. Collect them with `metrics.mjs`
and add them here.

## Earlier measurements (#629)

Three runs per configuration on one source revision (the files in
[tools/ci/evidence](https://github.com/lamberto15/nestjs-monorepo-template/tree/main/tools/ci/evidence))
selected **two API e2e shards** (6.37 median minutes and 11.30 runner-minutes,
against 8.55 and 12.75 for three shards, 8.77 and 14.67 for six) and
**unsharded unit coverage** (6.83 median runner-minutes against 9.95 sharded,
4.68 against 4.93 minutes). The dispatch inputs that ran them (`benchmark`,
`e2e_shards`, `unit_layout`, `validation_scope`) were removed in #681. To
compare layouts again, dispatch the workflow on a branch that carries the
layout and collect the runs with `metrics.mjs`.

## Where the test time goes

The e2e suite is the floor: about 1,540 s of test time (each test boots an
app on its own database copy), plus import time (22–32% of Vitest's tracked
time). Two shards on four workers each run 205–259 s of it. The
largest file, `approvals.e2e-spec.ts` (152 s, 53 tests), decides the heavier
shard. API unit coverage takes about a minute, mostly imports. Web coverage
(jsdom) takes about four minutes. Further gains are in the tests themselves,
for example fewer app boots per file, with isolation and thresholds kept.

## Release rollout

Automatic rollout remains hard-disabled in CI. The separately reviewed manual
Deploy workflow consumes a successful main release manifest through the protected
production environment. No production variables or credentials are changed. Manifest bootstrap
is an explicit full manual build on `main`; it does not deploy. Mixed digest
render tests prove the chart receives the manifest's rebuilt API digest and reused
web/Gotenberg digests. See [CI and publishing](deployment.md#ci) for trust checks
and retention/recovery behavior.
