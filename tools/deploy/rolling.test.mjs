// The rolling deploy's tests (tools/deploy/rolling.mjs):
//   node --test tools/deploy/rolling.test.mjs
// A fake docker keeps the containers in memory; no Docker needed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULTS, DeployError, parseArgs, rollingDeploy } from './rolling.mjs';

/** A fake docker: `service` has `old` containers; scaling adds new ones with `newHealth`. */
function fakeDocker({
  old = ['o1', 'o2'],
  newHealth = ['healthy', 'healthy'],
} = {}) {
  const calls = [];
  const containers = new Map(
    old.map((id) => [id, { Status: 'running', Health: { Status: 'healthy' } }]),
  );
  let created = 0;
  const run = async (args) => {
    calls.push(args.join(' '));
    const cmd = args.filter((a) => !a.startsWith('-')).join(' ');
    if (args[0] === 'compose' && args.includes('ps')) {
      return { code: 0, stdout: [...containers.keys()].join('\n') + '\n' };
    }
    if (args[0] === 'compose' && args.includes('--scale')) {
      const want = Number(args[args.indexOf('--scale') + 1].split('=')[1]);
      while (containers.size < want) {
        const health = newHealth[created++] ?? 'healthy';
        containers.set(`n${created}`, {
          Status: health === 'exited' ? 'exited' : 'running',
          Health: health === 'exited' ? undefined : { Status: health },
        });
      }
      return { code: 0, stdout: '' };
    }
    if (args[0] === 'inspect') {
      const c = containers.get(args.at(-1));
      return c
        ? { code: 0, stdout: JSON.stringify(c) }
        : { code: 1, stdout: '' };
    }
    if (args[0] === 'rm') {
      for (const id of args.slice(2)) containers.delete(id);
      return { code: 0, stdout: '' };
    }
    return { code: 0, stdout: '', cmd };
  };
  return { run, calls, containers };
}

const opts = (extra = {}) => ({
  ...DEFAULTS,
  services: ['api'],
  settleS: 0,
  pollMs: 0,
  files: [],
  ...extra,
});
const quiet = { log: () => {}, sleep: async () => {}, env: {} };

describe('parseArgs', () => {
  it('has defaults and reads the flags', () => {
    assert.deepEqual(parseArgs([]).services, ['api', 'worker']);
    const o = parseArgs([
      '--services',
      'api',
      '--skip-build',
      '--skip-migrate',
      '-p',
      'x',
      '-f',
      'a.yaml',
      '-f',
      'b.yaml',
      '--settle',
      '3',
    ]);
    assert.deepEqual(
      [o.services, o.build, o.migrate, o.project, o.files, o.settleS],
      [['api'], false, false, 'x', ['a.yaml', 'b.yaml'], 3],
    );
  });
  it('rejects what it does not know', () => {
    assert.throws(() => parseArgs(['--nope']), DeployError);
    assert.throws(() => parseArgs(['--settle']), DeployError);
    assert.throws(() => parseArgs(['--settle', '-1']), DeployError);
  });
});

describe('rollingDeploy', () => {
  it('builds, migrates, starts 2n, then stops and removes the old ones by id', async () => {
    const d = fakeDocker();
    await rollingDeploy(opts(), { run: d.run, ...quiet });
    const joined = d.calls.join('\n');
    assert.match(joined, /compose build migrate api/);
    assert.ok(
      d.calls.findIndex((c) => c.includes('run --rm --no-deps migrate')) <
        d.calls.findIndex((c) => c.includes('--scale api=4')),
    );
    assert.match(
      joined,
      /compose up -d --no-deps --no-recreate --scale api=4 api/,
    );
    assert.ok(d.calls.includes('stop o1') && d.calls.includes('stop o2'));
    assert.ok(d.calls.includes('rm -f o1 o2'));
    assert.deepEqual([...d.containers.keys()], ['n1', 'n2']);
  });

  it('pulls a published image instead of building it', async () => {
    const d = fakeDocker();
    await rollingDeploy(opts(), {
      run: d.run,
      ...quiet,
      env: { APP_IMAGE: 'ghcr.io/o/r:abc' },
    });
    assert.match(d.calls.join('\n'), /compose pull migrate api/);
    assert.doesNotMatch(d.calls.join('\n'), /compose build/);
  });

  it('verifies the published images first when VERIFY_IMAGES is set', async () => {
    const d = fakeDocker();
    const seen = [];
    await rollingDeploy(opts(), {
      run: d.run,
      ...quiet,
      env: { APP_IMAGE: 'ghcr.io/o/r:abc', VERIFY_IMAGES: '1' },
      verify: async () => (seen.push('verify'), 0),
    });
    assert.deepEqual(seen, ['verify']);
  });

  it('stops before pulling when verification fails', async () => {
    const d = fakeDocker();
    await assert.rejects(
      rollingDeploy(opts(), {
        run: d.run,
        ...quiet,
        env: { APP_IMAGE: 'ghcr.io/o/r:abc', VERIFY_IMAGES: '1' },
        verify: async () => 1,
      }),
      DeployError,
    );
    assert.doesNotMatch(d.calls.join('\n'), /compose pull/);
  });

  it('does not verify unless VERIFY_IMAGES is set', async () => {
    const d = fakeDocker();
    await rollingDeploy(opts(), {
      run: d.run,
      ...quiet,
      env: { APP_IMAGE: 'ghcr.io/o/r:abc' },
      verify: async () => {
        throw new Error('called');
      },
    });
  });

  it('passes the project, files and env file to every compose call', async () => {
    const d = fakeDocker();
    await rollingDeploy(
      opts({ project: 'p', files: ['a.yaml'], envFile: 'e' }),
      { run: d.run, ...quiet },
    );
    for (const c of d.calls.filter((c) => c.startsWith('compose'))) {
      assert.match(c, /^compose --env-file e -p p -f a\.yaml /);
    }
  });

  it('waits for an unhealthy-to-be starting container, and keeps the old ones until then', async () => {
    const d = fakeDocker({ newHealth: ['starting', 'healthy'] });
    let polls = 0;
    const run = async (args) => {
      if (args[0] === 'inspect' && args.at(-1) === 'n1' && ++polls === 3)
        d.containers.get('n1').Health.Status = 'healthy';
      if (args[0] === 'stop')
        assert.ok(polls >= 3, 'old stopped before the new were healthy');
      return d.run(args);
    };
    await rollingDeploy(opts(), { run, ...quiet });
    assert.ok(polls >= 3);
  });

  it('aborts and removes the new containers when one turns unhealthy', async () => {
    const d = fakeDocker({ newHealth: ['healthy', 'unhealthy'] });
    await assert.rejects(
      rollingDeploy(opts(), { run: d.run, ...quiet }),
      /unhealthy.*old keep serving/,
    );
    assert.deepEqual([...d.containers.keys()], ['o1', 'o2']);
    assert.ok(!d.calls.some((c) => c.startsWith('stop')));
  });

  it('aborts when a new container exits', async () => {
    const d = fakeDocker({ newHealth: ['exited', 'healthy'] });
    await assert.rejects(
      rollingDeploy(opts(), { run: d.run, ...quiet }),
      DeployError,
    );
    assert.deepEqual([...d.containers.keys()], ['o1', 'o2']);
  });

  it('aborts on the health timeout', async () => {
    const d = fakeDocker({ newHealth: ['starting', 'starting'] });
    let t = 0;
    await assert.rejects(
      rollingDeploy(opts({ healthTimeoutS: 5 }), {
        run: d.run,
        ...quiet,
        now: () => (t += 2000),
      }),
      /not healthy after 5 s/,
    );
    assert.deepEqual([...d.containers.keys()], ['o1', 'o2']);
  });

  it('stops when a step fails (no migration, no deploy)', async () => {
    const d = fakeDocker();
    const run = async (args) =>
      args.includes('migrate') && args.includes('run')
        ? { code: 1, stdout: '' }
        : d.run(args);
    await assert.rejects(
      rollingDeploy(opts(), { run, ...quiet }),
      /migrate failed/,
    );
    assert.ok(!d.calls.some((c) => c.includes('--scale')));
  });

  it('starts a service that is not running', async () => {
    const d = fakeDocker({ old: [] });
    await rollingDeploy(opts(), { run: d.run, ...quiet });
    assert.ok(d.calls.some((c) => c.endsWith('up -d --no-deps api')));
  });
});
