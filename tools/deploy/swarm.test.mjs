// Run with `node --test tools/deploy`. Docker sits behind the runner, so the
// deploy flow runs against a fake that answers like `docker` would.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, parseArgs, preflight, UsageError } from './swarm.mjs';
import { shortHash, toStack } from './render.mjs';

const secretFile = '/repo/secret.empty';
const rendered = () => ({
  name: 'swtest',
  'x-app': { a: 1 },
  services: {
    migrate: {
      image: 'app:2',
      command: null,
      deploy: { mode: 'replicated-job', replicas: 1 },
    },
    api: {
      image: 'app:2',
      entrypoint: null,
      profiles: ['app'],
      deploy: { resources: { limits: { cpus: 1, memory: '805306368' } } },
    },
    caddy: {
      image: 'caddy:1',
      ports: [{ target: 80, published: '80', mode: 'host' }],
    },
    redis: {
      image: 'redis',
      configs: [{ source: 'redis_sh', target: '/x', mode: '0555' }],
    },
  },
  networks: { default: { name: 'swtest_default' } },
  volumes: { postgres_data: { name: 'swtest_postgres_data' } },
  secrets: {
    jwt_secret: { name: 'swtest_jwt_secret', file: '/run/jwt' },
    smtp_url: { name: 'swtest_smtp_url', file: secretFile },
  },
  configs: {
    caddyfile: { name: 'swtest_caddyfile', file: '/repo/caddy/Caddyfile' },
  },
});

const files = {
  '/run/jwt': Buffer.from('s3cret'),
  [secretFile]: Buffer.alloc(0),
  '/repo/swarm.placeholder': Buffer.from('\n'),
  '/repo/caddy/Caddyfile': Buffer.from('{}'),
};
const readFile = (path) => files[path];

test('toStack: fixes what docker stack refuses', () => {
  const stack = toStack(rendered(), {
    stack: 'swtest',
    readFile,
    placeholder: '/repo/swarm.placeholder',
  });
  assert.equal(stack.name, undefined);
  assert.equal(stack['x-app'], undefined);
  assert.equal(stack.services.migrate.command, undefined);
  assert.equal(stack.services.api.entrypoint, undefined);
  assert.equal(stack.services.api.profiles, undefined);
  assert.equal(stack.services.api.deploy.resources.limits.cpus, '1');
  assert.equal(stack.services.caddy.ports[0].published, 80);
  assert.equal(stack.services.redis.configs[0].mode, 0o555);
  assert.equal(stack.networks.default.name, undefined);
  assert.equal(stack.volumes.postgres_data.name, undefined);
});

test('toStack: tmpfs entries become tmpfs volumes (docker stack ignores `tmpfs:`)', () => {
  const stack = toStack(
    {
      services: {
        postgres: {
          image: 'postgres',
          read_only: true,
          tmpfs: ['/tmp:size=64m', '/run/postgresql'],
          volumes: [
            { type: 'volume', source: 'postgres_data', target: '/data' },
          ],
        },
        gotenberg: {
          image: 'gotenberg',
          read_only: true,
          tmpfs: [
            '/tmp:size=512m',
            '/home/gotenberg:size=64m,uid=1001,gid=1001',
          ],
        },
        caddy: { image: 'caddy' },
      },
    },
    { stack: 'swtest', readFile, placeholder: '/repo/swarm.placeholder' },
  );
  assert.equal(stack.services.postgres.tmpfs, undefined);
  assert.equal(stack.services.postgres.read_only, true);
  assert.deepEqual(stack.services.postgres.volumes, [
    { type: 'volume', source: 'postgres_data', target: '/data' },
    { type: 'tmpfs', target: '/tmp', tmpfs: { size: 64 * 1024 * 1024 } },
    { type: 'tmpfs', target: '/run/postgresql' },
  ]);
  // uid and gid have no Swarm equivalent: the size stays.
  assert.deepEqual(stack.services.gotenberg.volumes, [
    { type: 'tmpfs', target: '/tmp', tmpfs: { size: 512 * 1024 * 1024 } },
    {
      type: 'tmpfs',
      target: '/home/gotenberg',
      tmpfs: { size: 64 * 1024 * 1024 },
    },
  ]);
  assert.equal(stack.services.caddy.volumes, undefined);
  assert.throws(
    () =>
      toStack(
        { services: { x: { image: 'x', tmpfs: ['/tmp:size=lots'] } } },
        { stack: 'swtest', readFile, placeholder: '/repo/swarm.placeholder' },
      ),
    /can't read the size/,
  );
});

test('toStack: secrets and configs are named by their content, empty ones use the placeholder', () => {
  const stack = toStack(rendered(), {
    stack: 'swtest',
    readFile,
    placeholder: '/repo/swarm.placeholder',
  });
  assert.equal(
    stack.secrets.jwt_secret.name,
    `swtest_jwt_secret_${shortHash('s3cret')}`,
  );
  assert.equal(stack.secrets.smtp_url.file, '/repo/swarm.placeholder');
  assert.equal(
    stack.secrets.smtp_url.name,
    `swtest_smtp_url_${shortHash('\n')}`,
  );
  assert.equal(
    stack.configs.caddyfile.name,
    `swtest_caddyfile_${shortHash('{}')}`,
  );
  // A changed file is a new secret; the same content keeps its name.
  const changed = { ...files, '/run/jwt': Buffer.from('other') };
  const again = toStack(rendered(), {
    stack: 'swtest',
    readFile: (p) => changed[p],
    placeholder: '/repo/swarm.placeholder',
  });
  assert.notEqual(again.secrets.jwt_secret.name, stack.secrets.jwt_secret.name);
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs([]).command, 'deploy');
  const options = parseArgs([
    'rollback',
    '--stack',
    's',
    '--service',
    'api',
    '--service',
    'worker',
    '--timeout',
    '30',
  ]);
  assert.equal(options.command, 'rollback');
  assert.equal(options.stack, 's');
  assert.deepEqual(options.services, ['api', 'worker']);
  assert.equal(options.timeout, 30);
  assert.throws(() => parseArgs(['--bogus']), UsageError);
  assert.throws(() => parseArgs(['--stack']), UsageError);
  assert.throws(() => parseArgs(['--timeout', '0']), UsageError);
});

/**
 * A fake Docker. `scenario` sets what the migrate job does and how the
 * api's update ends ("completed" or "rollback_completed").
 */
function fakeDocker({
  migrate = 'complete',
  update = 'completed',
  swarm = true,
  labelled = true,
} = {}) {
  const calls = [];
  let deployed = 0;
  let clock = 0;
  const runner = async (command, args, { input } = {}) => {
    const line = `${command} ${args.join(' ')}`;
    calls.push({ line, input });
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const fail = (stderr) => ({ code: 1, stdout: '', stderr });
    if (args[0] === 'compose') {
      const full = args.includes('--profile');
      const config = rendered();
      if (!full) {
        delete config.services.api;
        delete config.services.caddy;
      }
      config.services.api &&
        (config.services.api.deploy.placement = {
          constraints: ['node.labels.stateful == true'],
        });
      return ok(JSON.stringify(config));
    }
    if (line.startsWith('docker stack config')) return ok('version: "3.13"');
    if (line.startsWith('docker info')) {
      return ok(
        JSON.stringify({
          LocalNodeState: swarm ? 'active' : 'inactive',
          ControlAvailable: swarm,
        }),
      );
    }
    if (line.startsWith('docker node ls')) return ok('n1\n');
    if (line.startsWith('docker node inspect'))
      return ok(JSON.stringify(labelled ? { stateful: 'true' } : {}));
    if (line.startsWith('docker stack deploy')) {
      deployed += 1;
      return ok();
    }
    if (
      line.startsWith('docker service ps') &&
      line.includes('swtest_migrate')
    ) {
      if (args.includes('-q')) return ok('');
      if (deployed === 0) return ok('');
      if (migrate === 'complete')
        return ok(
          't2|Complete 1 second ago|\nt1|Failed 9 seconds ago|task: non-zero exit (1)\n',
        );
      return ok(
        't3|Failed 1 second ago|task: non-zero exit (1)\n' +
          ['t4', 't5', 't6']
            .map((id) => `${id}|Failed 5 seconds ago|task: non-zero exit (1)`)
            .join('\n'),
      );
    }
    if (line.startsWith('docker service ps')) {
      return ok('app:1|Shutdown 2 seconds ago|task: non-zero exit (1)\n');
    }
    if (line.startsWith('docker service ls')) {
      const rows = ['api', 'caddy', 'redis'].map(
        (name) => `swtest_${name}|${update === 'completed' ? '2/2' : '2/2'}`,
      );
      return ok(rows.join('\n'));
    }
    if (line.startsWith('docker service inspect')) {
      const name = args.at(-1);
      const base = {
        Spec: { TaskTemplate: { ContainerSpec: { Image: 'app:2' } } },
      };
      if (name !== 'swtest_api') return ok(JSON.stringify([base]));
      clock += 1;
      const state = clock < 2 ? 'updating' : update;
      return ok(
        JSON.stringify([
          {
            ...base,
            UpdateStatus: {
              State: state,
              StartedAt: deployed >= 2 ? 'new' : 'old',
              Message: 'm',
            },
            PreviousSpec: {},
          },
        ]),
      );
    }
    if (line.startsWith('docker service rollback')) return ok();
    return fail(`unexpected: ${line}`);
  };
  return { runner, calls };
}

const baseDeps = (docker) => {
  const lines = [];
  let now = 1_000;
  return {
    lines,
    deps: {
      runner: docker.runner,
      env: {},
      log: (line) => lines.push(line),
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
      readFile,
      root: '/repo',
      pollMs: 100,
      graceMs: 300,
    },
  };
};

test('deploy: stores and migrations first, then the app; exits 0 when updated', async () => {
  const docker = fakeDocker();
  const { deps, lines } = baseDeps(docker);
  const code = await main(['deploy', '--stack', 'swtest'], deps);
  assert.equal(code, 0, lines.join('\n'));
  const deploys = docker.calls.filter((call) =>
    call.line.startsWith('docker stack deploy'),
  );
  assert.equal(deploys.length, 2);
  assert.match(deploys[0].line, /--with-registry-auth/);
  assert.equal(
    JSON.parse(deploys[0].input).services.api,
    undefined,
    'the first deploy has no api',
  );
  assert.ok(JSON.parse(deploys[1].input).services.api);
  const order = docker.calls.map((call) => call.line);
  assert.ok(
    order.findIndex((l) => l.includes('service ps') && l.includes('migrate')) <
      order.lastIndexOf(deploys[1].line),
  );
  assert.ok(lines.includes('api: ok (updated)'));
  assert.ok(lines.includes('deployed'));
});

test('deploy: the same SWARM_DEPLOY_ID in both renders (the job reruns once per deploy)', async () => {
  const docker = fakeDocker();
  const { deps } = baseDeps(docker);
  const seen = [];
  const run = deps.runner;
  deps.runner = async (command, args, options) => {
    if (args[0] === 'compose') seen.push(options.env.SWARM_DEPLOY_ID);
    return run(command, args, options);
  };
  await main(['deploy', '--stack', 'swtest'], deps);
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.ok(seen[0]);
});

test('deploy: a rolled back update exits 1 and says so', async () => {
  const docker = fakeDocker({ update: 'rollback_completed' });
  const { deps, lines } = baseDeps(docker);
  const code = await main(['deploy', '--stack', 'swtest'], deps);
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.startsWith('api: rolled-back')));
  assert.ok(
    lines.some((line) => line.includes('rolled back to the previous version')),
  );
  assert.ok(lines.some((line) => line.includes('failed task')));
});

test('deploy: a paused update exits 3', async () => {
  const docker = fakeDocker({ update: 'paused' });
  const { deps } = baseDeps(docker);
  assert.equal(await main(['deploy', '--stack', 'swtest'], deps), 3);
});

test('deploy: failing migrations stop before the app is touched', async () => {
  const docker = fakeDocker({ migrate: 'fail' });
  const { deps, lines } = baseDeps(docker);
  const code = await main(['deploy', '--stack', 'swtest'], deps);
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes('migrations failed')));
  const deploys = docker.calls.filter((call) =>
    call.line.startsWith('docker stack deploy'),
  );
  assert.equal(deploys.length, 1, 'only the stores were deployed');
});

test('deploy: refuses a Docker that is not a Swarm manager, and a missing node label', async () => {
  let docker = fakeDocker({ swarm: false });
  let { deps, lines } = baseDeps(docker);
  assert.equal(await main(['deploy', '--stack', 'swtest'], deps), 1);
  assert.ok(lines.some((line) => line.includes('docker swarm init')));
  assert.equal(
    docker.calls.filter((call) => call.line.startsWith('docker stack deploy'))
      .length,
    0,
  );

  docker = fakeDocker({ labelled: false });
  ({ deps, lines } = baseDeps(docker));
  assert.equal(await main(['deploy', '--stack', 'swtest'], deps), 1);
  assert.ok(lines.some((line) => line.includes('--label-add stateful=true')));
});

test('rollback: docker service rollback of api and worker (or --service)', async () => {
  const docker = fakeDocker();
  const { deps } = baseDeps(docker);
  assert.equal(
    await main(['rollback', '--stack', 'swtest', '--service', 'api'], deps),
    0,
  );
  const rollbacks = docker.calls.filter((call) =>
    call.line.startsWith('docker service rollback'),
  );
  assert.equal(rollbacks.length, 1);
  assert.match(rollbacks[0].line, /swtest_api$/);
});

test('check validates the stack file with docker stack config', async () => {
  const docker = fakeDocker();
  const { deps, lines } = baseDeps(docker);
  assert.equal(await main(['check', '--stack', 'swtest'], deps), 0);
  assert.ok(
    docker.calls.some((call) => call.line === 'docker stack config -c -'),
  );
  assert.ok(lines[0].startsWith('stack file valid'));
});

test('usage errors exit 2', async () => {
  const { deps } = baseDeps(fakeDocker());
  assert.equal(await main(['nonsense'], deps), 2);
  assert.equal(await main(['deploy', '--stack', 'Bad Name'], deps), 2);
});

test('preflight reads node.labels constraints with or without spaces, in linear time', async () => {
  const ok = (value) => ({
    code: 0,
    stdout: JSON.stringify(value),
    stderr: '',
  });
  const ctx = {
    env: {},
    root: '.',
    run: async (command, args) => {
      if (args[0] === 'info')
        return ok({ LocalNodeState: 'active', ControlAvailable: true });
      if (args[1] === 'ls') return { code: 0, stdout: 'n1\n', stderr: '' };
      return ok({ stateful: 'true', zone: 'eu west' });
    },
  };
  const placed = (...constraints) => ({
    services: { db: { deploy: { placement: { constraints } } } },
  });
  await preflight(
    ctx,
    placed('node.labels.stateful==true', ' node.labels.zone ==  eu west '),
  );
  await assert.rejects(
    preflight(ctx, placed('node.labels.zone == eu')),
    /no node matches node\.labels\.zone == eu/,
  );
  // Not a constraint it reads (the value is not on one line): left alone,
  // quickly. The pattern it replaced took about a second on this one.
  const started = performance.now();
  await preflight(
    ctx,
    placed(`node.labels.zone ==${'\t'.repeat(50_000)}\nx\ny`),
  );
  assert.ok(performance.now() - started < 250);
});
