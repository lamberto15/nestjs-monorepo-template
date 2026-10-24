import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function verifyMembership(all, shards) {
  const members = shards.flat();
  assert.ok(all.length, 'the suite must contain tests');
  assert.equal(
    new Set(all).size,
    all.length,
    'the suite contains duplicate paths',
  );
  assert.equal(
    new Set(members).size,
    members.length,
    'a test appears in multiple shards',
  );
  assert.deepEqual(
    members.toSorted((a, b) => a.localeCompare(b)),
    all.toSorted((a, b) => a.localeCompare(b)),
    'shards must cover every test exactly once',
  );
}

export function verifyShards(run = execFileSync) {
  const report = [];
  for (const [workspace, config, counts] of [
    ['api', 'vitest.config.e2e.ts', [2, 3, 6]],
    ['api', 'vitest.config.ts', [3]],
    ['web', 'vitest.config.ts', [3]],
  ]) {
    // `vitest list` does not apply --shard. Use the installed configured
    // sequencer, exactly as Vitest does, rather than copying its algorithm.
    const script = `
      import { createVitest } from 'vitest/node';
      const ctx = await createVitest({ config: ${JSON.stringify(config)}, watch: false });
      try {
        const specs = await ctx.globTestSpecifications();
        const all = specs.map(spec => spec.moduleId);
        const groups = [];
        for (const count of ${JSON.stringify(counts)}) {
          const shards = [];
          for (let index = 1; index <= count; index++) {
            ctx.config.shard = { index, count };
            const sequencer = new ctx.config.sequence.sequencer(ctx);
            shards.push((await sequencer.shard(specs)).map(spec => spec.moduleId));
          }
          groups.push({ count, shards });
        }
        console.log(JSON.stringify({ all, groups }));
      } finally { await ctx.close(); }
    `;
    const { all, groups } = JSON.parse(
      run(
        'pnpm',
        [
          '--filter',
          `@nestjs-monorepo-template/${workspace}`,
          'exec',
          'node',
          '--input-type=module',
          '-e',
          script,
        ],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      ),
    );
    for (const { count, shards } of groups) {
      verifyMembership(all, shards);
      report.push({
        workspace,
        config,
        count,
        tests: all.length,
        membership: shards.map((s) => s.length),
      });
    }
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(verifyShards(), null, 2));
