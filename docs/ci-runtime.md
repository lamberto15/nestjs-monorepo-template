# CI runtime and runner usage

The target is ordinary affected PR validation in roughly 5–10 minutes with lower
runner consumption. Measurements, rather than shard count alone, select defaults.
The implementation is tracked in [#629](https://github.com/lamberto15/nestjs-monorepo-template/issues/629).

## Measurement protocol

Run the same source revision three times per configuration, on Ubuntu 24.04 with
the same pnpm lockfile and service images. Do not mix benchmark revisions or
compare local hardware with GitHub runners. Dispatch the existing CI / CD workflow
with `benchmark=e2e` and `e2e_shards=2`, `3`, or `6`; only API E2E runs, with at
most two shards concurrently. Use `benchmark=unit` and `unit_layout=whole` or
`sharded` to compare full unit coverage with the current matrices. Coverage
benchmarks bypass task-cache replay; thresholds and isolated services are unchanged.
Keep each benchmark family sequential. At most one E2E run and one unit run may
measure concurrently: two E2E runners and at most four unit runners.
Ordinary validation, publication and deployment are excluded from benchmark mode.

```bash
gh workflow run ci.yml --ref <branch> -f benchmark=e2e -f e2e_shards=2
gh workflow run ci.yml --ref <branch> -f benchmark=unit -f unit_layout=whole
node tools/ci/metrics.mjs collect <owner/repo> <run-id> /tmp/run.json
node tools/ci/metrics.mjs select /tmp/configurations.json
```

The selection input maps each configuration name to exactly three collected run
objects. Pick the lowest median runner-minutes configuration whose median
validation time is at most ten minutes. If none qualifies, retain the fastest
median validation configuration and record that the target was missed. Keep
coverage merging only if sharding wins. Do not lower coverage thresholds.

Manual `validation_scope=api`, `web`, `shared`, `infrastructure`, or `ci` runs
measure representative routing on the same source without committing synthetic
application edits. These scenarios do not publish; `full` remains the manual
default, and bootstrap requires comprehensive validation. Scenario timings measure
the primary workflow, not the sum of companion workflows or account-wide billing.

## Selected API E2E layout

Three runs per configuration selected **two API E2E shards**, at most two
concurrently. All layouts met the ten-minute median validation target; two shards
used the fewest median runner-minutes. Services and test isolation are unchanged.

| Shards | Median validation minutes | Median runner-minutes |
| --- | --- | --- |
| 2 | 6.37 | 11.30 |
| 3 | 8.55 | 12.75 |
| 6 | 8.77 | 14.67 |

## Selected unit coverage layout

Three comparable runs per layout selected **unsharded unit coverage**. Median
runner-minutes fell from 9.95 to 6.83 (31.3% less); median validation elapsed was
4.68 versus 4.93 minutes. Both meet the ten-minute target, so runner cost decides.
Ordinary runs enforce thresholds directly. Sharded reports and merging remain
available for explicit measurement, with the same thresholds enforced after merging.

## Reading the evidence

[Before measurements](https://github.com/lamberto15/nestjs-monorepo-template/tree/main/tools/ci/evidence) contain run IDs, source revisions,
elapsed/validation minutes, runner-minutes, peak occupied runners, job scheduling
delay and observed Turbo task cache hits/misses. Runner-minutes sum active job
durations, not wall-clock duration or GitHub's rounded billing units. Gate completion
marks validation completion; publication/deployment contribute only to total elapsed.

Jobs API `created_at` is distinct from workflow creation. `createdAfterRunSeconds`
includes dependency and dispatch waits before job creation. For the configured
matrices, `matrixWaitSeconds` estimates time waiting for one of two slots after
creation. `schedulingSeconds` is the remaining created-to-start delay after slot
availability, including runner queueing and dispatcher latency. GitHub does not
expose allocator queue entry timestamps here: do not label the residual as pure
runner queue time. Compare dependency structure before drawing queue conclusions.
Cache hit counts come from downloaded logs; absent hits are not proof no dependency
or Docker cache was used.

The successful `main` push for #628, run `40059092538`, ran only `changes` and
`ci-validate`. Sampled API PR `40076584955` consumed about 41 runner-minutes;
its `main` counterpart `40077288057` consumed about 86. These are historical
observations, not a controlled before/after speedup claim. Benchmarks and affected
post-change runs must supply that comparison.

## Representative affected validation

These are primary-workflow observations. The before runs are historical PRs;
after runs explicitly select a manual scenario on one revision. Different code,
cache and scheduling conditions mean these are not controlled speedup percentages.
The shard/coverage comparisons above are controlled on one source revision.

| Scenario | Historical PR runner-minutes | After runner-minutes | After validation minutes | After peak runners |
| --- | --- | --- | --- | --- |
| api | 41.30 | 22.93 | 5.95 | 8 |
| web | 27.65 | 15.00 | 6.23 | 6 |
| infrastructure | 41.25 | 13.63 | 7.73 | 4 |
| ci | 0.12 | 0.47 | 0.58 | 1 |

## Where the test time goes

The saved `test-profile.json` records Vitest's own timing breakdown. API unit
coverage took 56.19 seconds and attributed 82% of tracked time to imports:
626 modules evaluated 2265 times. Web coverage took 243.89 seconds, with 57%
tests, 22% imports and 11% environment setup. API E2E shards attributed 66–76%
to test work and 22–32% to imports. Tracked percentages aggregate work across
workers; they are not a partition of wall-clock elapsed time.

Vitest is not the dominant explanation by itself. Future test-level optimization
should profile repeated imports and heavyweight web render fixtures, preserving
isolation and thresholds. The web filesystem module cache remains disabled for
its documented typed-glob invalidation bug; reducing CI matrices does not remove
that guard or disable test isolation.

## Release rollout

Automatic rollout remains hard-disabled in CI. The separately reviewed manual
Deploy workflow consumes a successful main release manifest through the protected
production environment. No production variables or credentials are changed. Manifest bootstrap
is an explicit full manual build on `main`; it does not deploy. Mixed digest
render tests prove the chart receives the manifest's rebuilt API digest and reused
web/Gotenberg digests. See [CI and publishing](deployment.md#ci) for trust checks
and retention/recovery behavior.
