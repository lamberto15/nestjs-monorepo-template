// The blue-green script's tests (node --test tools/deploy/blue-green.test.mjs):
// a fake Docker behind the injectable runner, no daemon needed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDeployer, DeployError, main } from './blue-green.mjs';

const EDGE = 'demo_edge';

/** A small Docker: containers per colour with their edge aliases, and a call log. */
function fakeDocker({
  replicas = 2,
  smokeFails = false,
  unhealthy = false,
} = {}) {
  const containers = []; // {id, colour, status, health, image, aliases}
  const calls = [];
  let clock = 0;
  const sleeps = [];
  let ids = 0;
  const spawn = (colour, image, alias) => {
    for (let i = 0; i < replicas; i++) {
      containers.push({
        id: `c${++ids}`,
        colour,
        status: 'running',
        health: unhealthy ? 'starting' : 'healthy',
        image,
        aliases: [alias, `api-${colour}`],
      });
    }
  };
  const inspect = (c) => ({
    Id: c.id,
    Name: `/demo-api-${c.colour}-${c.id}`,
    Image: `sha-of-${c.image}`,
    RestartCount: 0,
    Config: { Image: c.image },
    State: { Status: c.status, Health: { Status: c.health } },
    NetworkSettings: {
      Networks: {
        [EDGE]: { Aliases: c.aliases, IPAddress: `10.0.0.${c.id.slice(1)}` },
      },
    },
  });
  const run = async (cmd, args, { env = {} } = {}) => {
    calls.push({ cmd, args, env });
    // compose's global flags are for the real docker; the fake reads the verb
    if (args[0] === 'compose') {
      const rest = args.slice(1);
      while (['-f', '--env-file', '-p'].includes(rest[0])) rest.splice(0, 2);
      args = ['compose', ...rest];
    }
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    assert.equal(cmd, 'docker');
    const a = args[0] === 'compose' ? args.slice(1) : args;
    const svc = (name) => name.replace('api-', '');
    if (args[0] === 'compose') {
      if (a[0] === 'config') {
        const services = {};
        for (const c of ['blue', 'green']) {
          services[`api-${c}`] = { deploy: { replicas } };
        }
        return ok(
          JSON.stringify({
            name: 'demo',
            services,
            networks: { edge: { name: EDGE } },
          }),
        );
      }
      if (a[0] === 'up' && a.includes('api-blue')) {
        const colour = 'blue';
        return recreate(colour);
      }
      if (a[0] === 'up' && a.includes('api-green')) return recreate('green');
      if (a[0] === 'start') {
        for (const c of containers.filter((x) => x.colour === svc(a[1]))) {
          c.status = 'running';
          c.aliases = [`api-${c.colour}`];
        }
        return ok();
      }
      if (a[0] === 'stop') {
        for (const c of containers.filter((x) => x.colour === svc(a[1])))
          c.status = 'exited';
        return ok();
      }
      return ok();
    }
    function recreate(colour) {
      for (let i = containers.length - 1; i >= 0; i--) {
        if (containers[i].colour === colour) containers.splice(i, 1);
      }
      spawn(
        colour,
        env[`APP_IMAGE_${colour.toUpperCase()}`],
        env[`API_${colour.toUpperCase()}_EDGE_ALIAS`],
      );
      return ok();
    }
    if (a[0] === 'ps') {
      const colour = args
        .find((x) => x.startsWith('label=com.docker.compose.service=api-'))
        .split('=')
        .at(-1);
      return ok(
        containers
          .filter((c) => `api-${c.colour}` === colour)
          .map((c) => c.id)
          .join('\n'),
      );
    }
    if (a[0] === 'inspect')
      return ok(
        JSON.stringify(
          a.slice(1).map((id) => inspect(containers.find((c) => c.id === id))),
        ),
      );
    if (a[0] === 'network' && a[1] === 'disconnect') {
      containers.find((c) => c.id === a[3]).aliases = null;
      return ok();
    }
    if (a[0] === 'network' && a[1] === 'connect') {
      const aliases = [];
      for (let i = 2; i < a.length; i++)
        if (a[i] === '--alias') aliases.push(a[++i]);
      containers.find((c) => c.id === a.at(-1)).aliases = aliases;
      return ok();
    }
    if (a[0] === 'exec') {
      return smokeFails ? { code: 1, stdout: '', stderr: 'boom' } : ok('200');
    }
    if (a[0] === 'image') return { code: 0, stdout: '', stderr: '' };
    return ok();
  };
  const deps = {
    run,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    log: () => {},
  };
  return { containers, calls, sleeps, deps, spawn };
}

const compose = (calls, verb) =>
  calls.filter((c) => c.args[0] === 'compose' && c.args[1] === verb);
const liveColours = (containers) => [
  ...new Set(
    containers.filter((c) => c.aliases?.includes('api')).map((c) => c.colour),
  ),
];

describe('blue-green', () => {
  it('first deploy starts blue and makes it live', async () => {
    const docker = fakeDocker();
    const result = await createDeployer(docker.deps).deploy({
      image: 'app:1',
      grace: 'keep',
    });
    assert.equal(result.live, 'blue');
    assert.deepEqual(liveColours(docker.containers), ['blue']);
    // migrations ran with the new image, before the colour started
    const order = docker.calls.map((c) => c.args.join(' '));
    const migrate = order.findIndex((x) => x.startsWith('compose run'));
    const up = order.findIndex((x) =>
      x.startsWith('compose up -d --no-deps --force-recreate'),
    );
    assert.ok(migrate >= 0 && migrate < up);
    assert.equal(compose(docker.calls, 'run')[0].env.APP_IMAGE, 'app:1');
  });

  it('deploys to the idle colour, switches with an overlap, stops the old one after the grace', async () => {
    const docker = fakeDocker();
    docker.spawn('blue', 'app:1', 'api');
    const result = await createDeployer(docker.deps).deploy({
      image: 'app:2',
      grace: 120,
      settle: 7,
    });
    assert.equal(result.live, 'green');
    assert.equal(result.previous, 'blue');
    assert.deepEqual(liveColours(docker.containers), ['green']);
    assert.equal(
      docker.containers.find((c) => c.colour === 'green').image,
      'app:2',
    );
    // the old colour left `api` only after the settle wait, and was stopped after the grace
    assert.deepEqual(docker.sleeps.slice(-2), [7000, 120000]);
    assert.ok(
      docker.containers
        .filter((c) => c.colour === 'blue')
        .every((c) => c.status === 'exited'),
    );
    // the worker follows the new image
    const worker = compose(docker.calls, 'up').find((c) =>
      c.args.includes('worker'),
    );
    assert.equal(worker.env.APP_IMAGE, 'app:2');
  });

  it('never leaves api empty while switching', async () => {
    const docker = fakeDocker();
    docker.spawn('blue', 'app:1', 'api');
    const seen = [];
    const inner = docker.deps.run;
    docker.deps.run = async (cmd, args, o) => {
      const r = await inner(cmd, args, o);
      if (args[0] === 'network')
        seen.push(
          docker.containers.filter((c) => c.aliases?.includes('api')).length,
        );
      return r;
    };
    await createDeployer(docker.deps).deploy({ image: 'app:2', grace: 'keep' });
    // the count of api containers is only ever 2 (old), 3 and 4 (overlap) or 2 (new): never 0
    assert.ok(
      seen.every((n) => n >= 1),
      seen.join(),
    );
  });

  it('keeps the old colour with grace=keep and finish stops it', async () => {
    const docker = fakeDocker();
    docker.spawn('blue', 'app:1', 'api');
    const deployer = createDeployer(docker.deps);
    await deployer.deploy({ image: 'app:2', grace: 'keep' });
    assert.ok(
      docker.containers
        .filter((c) => c.colour === 'blue')
        .every((c) => c.status === 'running'),
    );
    await deployer.finish();
    assert.ok(
      docker.containers
        .filter((c) => c.colour === 'blue')
        .every((c) => c.status === 'exited'),
    );
  });

  it('switch flips back to the running old colour and moves the worker with it', async () => {
    const docker = fakeDocker();
    docker.spawn('blue', 'app:1', 'api');
    const deployer = createDeployer(docker.deps);
    await deployer.deploy({ image: 'app:2', grace: 'keep' });
    const result = await deployer.switchTo({});
    assert.equal(result.live, 'blue');
    assert.deepEqual(liveColours(docker.containers), ['blue']);
    const workers = compose(docker.calls, 'up').filter((c) =>
      c.args.includes('worker'),
    );
    assert.equal(workers.at(-1).env.APP_IMAGE, 'app:1');
    // nothing was started or recreated: instant
    assert.equal(compose(docker.calls, 'start').length, 0);
  });

  it('switch starts a stopped colour first', async () => {
    const docker = fakeDocker();
    docker.spawn('blue', 'app:1', 'api');
    const deployer = createDeployer(docker.deps);
    await deployer.deploy({ image: 'app:2', grace: 0 });
    assert.ok(
      docker.containers
        .filter((c) => c.colour === 'blue')
        .every((c) => c.status === 'exited'),
    );
    await deployer.switchTo({ noWorker: true });
    assert.equal(compose(docker.calls, 'start').length, 1);
    assert.deepEqual(liveColours(docker.containers), ['blue']);
  });

  it('a failed smoke check leaves the live colour untouched', async () => {
    const docker = fakeDocker({ smokeFails: true });
    docker.spawn('blue', 'app:1', 'api');
    await assert.rejects(
      createDeployer(docker.deps).deploy({ image: 'app:2' }),
      /smoke check failed/,
    );
    assert.deepEqual(liveColours(docker.containers), ['blue']);
    assert.equal(compose(docker.calls, 'stop').length, 0);
  });

  it('a colour that never turns healthy fails the deploy', async () => {
    const docker = fakeDocker({ unhealthy: true });
    docker.spawn('blue', 'app:1', 'api');
    await assert.rejects(
      createDeployer(docker.deps).deploy({ image: 'app:2', timeout: 10 }),
      /not healthy after 10s/,
    );
    assert.deepEqual(liveColours(docker.containers), ['blue']);
  });

  it('reads the live colour and the images in status', async () => {
    const docker = fakeDocker();
    docker.spawn('green', 'app:9', 'api');
    docker.spawn('blue', 'app:8', 'api-blue');
    const state = await createDeployer(docker.deps).status({ json: true });
    assert.equal(state.live, 'green');
    assert.equal(state.colours.blue[0].image, 'app:8');
  });

  it('refuses without the override file and without an image', async () => {
    const docker = fakeDocker();
    const inner = docker.deps.run;
    docker.deps.run = async (cmd, args, o) =>
      args[1] === 'config'
        ? {
            code: 0,
            stdout: JSON.stringify({ name: 'demo', services: {} }),
            stderr: '',
          }
        : inner(cmd, args, o);
    await assert.rejects(
      createDeployer(docker.deps).status(),
      /compose\.blue-green\.yaml/,
    );
    const other = fakeDocker();
    await assert.rejects(createDeployer(other.deps).deploy({}), DeployError);
  });

  it('passes the compose flags through and reports errors as exit code 1', async () => {
    const docker = fakeDocker();
    const code = await main(
      ['status', '-p', 'demo', '--env-file', 'x.env', '-f', 'a.yaml'],
      docker.deps,
    );
    assert.equal(code, 0);
    assert.deepEqual(docker.calls[0].args.slice(0, 7), [
      'compose',
      '-f',
      'a.yaml',
      '--env-file',
      'x.env',
      '-p',
      'demo',
    ]);
    assert.equal(await main(['deploy'], fakeDocker().deps), 1);
  });
});
