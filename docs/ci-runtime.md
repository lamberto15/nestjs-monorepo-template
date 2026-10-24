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
Keep benchmark runs sequential to avoid consuming the shared pool all at once.
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

## Reading the evidence

[Before measurements](../tools/ci/evidence/) contain run IDs, source revisions,
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

## Release rollout

Production rollout is hard-disabled in the workflow until separate review and
green CI. No production variables or credentials are changed. Manifest bootstrap
is an explicit full manual build on `main`; it does not deploy. Mixed digest
render tests prove the chart receives the manifest's rebuilt API digest and reused
web/Gotenberg digests. See [CI and publishing](deployment.md#ci) for trust checks
and retention/recovery behavior.
