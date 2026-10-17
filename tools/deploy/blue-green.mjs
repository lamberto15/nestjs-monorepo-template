#!/usr/bin/env node
// Blue-green deploys with Compose (docs/deploy-blue-green.md): two api
// colours (compose.blue-green.yaml), one live. The live colour's containers
// answer to `api` on the `edge` network, which is what Caddy resolves; the
// idle colour answers to its own name, so Caddy never sees it. Nothing is
// stored: the live colour is read from Docker, the images from the containers.
//
//   pnpm deploy:blue-green status
//   pnpm deploy:blue-green deploy --image ghcr.io/<owner>/<repo>:<sha> [--grace 300]
//   pnpm deploy:blue-green deploy --build            # from this checkout
//   pnpm deploy:blue-green switch                    # flip to the other colour
//   pnpm deploy:blue-green rollback                  # the same, as a name
//   pnpm deploy:blue-green finish                    # stop the idle colour now
//   node --test tools/deploy/blue-green.test.mjs     # its tests
//
// Options: -p/--project, -f/--file (repeatable), --env-file (as docker
// compose), --smoke-path /health (repeatable), --timeout <s> (healthy wait,
// 180), --settle <s> (Caddy's refresh + margin, 7), --grace <s|keep> (how
// long the old colour runs after a deploy, 300; 0 stops it at once; keep
// leaves it for `finish`), --no-migrate, --no-worker, --to blue|green
// (switch), --json (status).
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const COLOURS = ['blue', 'green'];
const other = (colour) => (colour === 'blue' ? 'green' : 'blue');
const service = (colour) => `api-${colour}`;
const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DeployError extends Error {}

/** The real runner: spawn, collect (and with `stream`, show) the output. */
export function spawnRunner(cmd, args, { env, stream } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stream) process.stderr.write(d);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stream) process.stderr.write(d);
    });
    child.on('error', (error) =>
      resolve({ code: 127, stdout, stderr: stderr + String(error) }),
    );
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * `deps`: run (the injectable runner: (cmd, args, {env, stream}) =>
 * {code, stdout, stderr}), sleep, now, log, and compose's global flags.
 */
export function createDeployer({
  run = spawnRunner,
  sleep = sleepReal,
  now = () => Date.now(),
  log = (line) => console.error(line),
  compose: composeFlags = [],
} = {}) {
  const docker = async (args, options = {}) => {
    const result = await run('docker', args, options);
    if (result.code !== 0 && !options.allowFail) {
      throw new DeployError(
        `docker ${args.slice(0, 3).join(' ')} failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(-600)}`,
      );
    }
    return result;
  };
  const compose = (args, options) =>
    docker(['compose', ...composeFlags, ...args], options);

  /** Project name, the edge network, the services and their replicas. */
  async function readConfig() {
    const { stdout } = await compose(['config', '--format', 'json']);
    const config = JSON.parse(stdout);
    for (const colour of COLOURS) {
      if (!config.services?.[service(colour)]) {
        throw new DeployError(
          `${service(colour)} is not in the Compose project: add compose.blue-green.yaml to COMPOSE_FILE ` +
            '(compose.yaml:compose.prod.yaml:compose.blue-green.yaml)',
        );
      }
    }
    return {
      project: config.name,
      edge: config.networks?.edge?.name ?? `${config.name}_edge`,
      replicas: Object.fromEntries(
        COLOURS.map((c) => [
          c,
          Number(config.services[service(c)].deploy?.replicas ?? 1),
        ]),
      ),
    };
  }

  async function inspectContainers(ids) {
    if (ids.length === 0) return [];
    const { stdout } = await docker(['inspect', ...ids]);
    return JSON.parse(stdout);
  }

  /** One colour's containers (running or not), as the facts the script needs. */
  async function colourContainers(config, colour) {
    const { stdout } = await docker([
      'ps',
      '-a',
      '--filter',
      `label=com.docker.compose.project=${config.project}`,
      '--filter',
      `label=com.docker.compose.service=${service(colour)}`,
      '--format',
      '{{.ID}}',
    ]);
    const ids = stdout.split('\n').filter(Boolean);
    return (await inspectContainers(ids)).map((c) => {
      const endpoint = c.NetworkSettings?.Networks?.[config.edge];
      return {
        id: c.Id,
        name: c.Name.replace(/^\//, ''),
        status: c.State?.Status,
        health: c.State?.Health?.Status ?? 'none',
        image: c.Config?.Image,
        imageId: c.Image,
        edgeIp: endpoint?.IPAddress ?? null,
        live: Boolean(endpoint?.Aliases?.includes('api')),
        restarts: c.RestartCount ?? 0,
      };
    });
  }

  /** The live colour (null before the first deploy), both colours' containers. */
  async function readState(config) {
    const colours = {};
    for (const colour of COLOURS) {
      colours[colour] = await colourContainers(config, colour);
    }
    const live = COLOURS.filter((c) =>
      colours[c].some((x) => x.live && x.status === 'running'),
    );
    return {
      colours,
      live: live.length === 1 ? live[0] : null,
      both: live.length === 2,
    };
  }

  const imageOf = (containers) =>
    containers.find((c) => c.image)?.image ?? null;

  /** The variables every compose call needs, so no colour moves by accident. */
  function colourEnv(state, { live, images = {} } = {}) {
    const env = {};
    for (const colour of COLOURS) {
      const image = images[colour] ?? imageOf(state.colours[colour]);
      if (image) env[`APP_IMAGE_${colour.toUpperCase()}`] = image;
      env[`API_${colour.toUpperCase()}_EDGE_ALIAS`] =
        live === colour ? 'api' : service(colour);
    }
    return env;
  }

  async function status({ json = false } = {}) {
    const config = await readConfig();
    const state = await readState(config);
    if (json) return { project: config.project, live: state.live, ...state };
    log(`project ${config.project}`);
    log(
      state.both
        ? 'live: both colours answer to api (an interrupted switch: run `switch`)'
        : state.live
          ? `live: ${state.live}`
          : 'live: none (the first deploy starts blue)',
    );
    for (const colour of COLOURS) {
      const containers = state.colours[colour];
      const role = colour === state.live ? 'live' : 'idle';
      const running = containers.filter((c) => c.status === 'running');
      log(
        `${colour.padEnd(5)} ${role}  ${running.length}/${containers.length} running  ${imageOf(containers) ?? '-'}`,
      );
      for (const c of containers) {
        log(`        ${c.name}  ${c.status}  health ${c.health}`);
      }
    }
    return { project: config.project, live: state.live, ...state };
  }

  async function waitHealthy(config, colour, timeoutSeconds) {
    const expected = config.replicas[colour];
    const deadline = now() + timeoutSeconds * 1000;
    for (;;) {
      const containers = (await colourContainers(config, colour)).filter(
        (c) => c.status !== 'removing',
      );
      const bad = containers.find(
        (c) =>
          c.status === 'exited' ||
          c.status === 'dead' ||
          c.status === 'restarting',
      );
      if (bad) {
        const logs = await docker(['logs', '--tail', '20', bad.id], {
          allowFail: true,
        });
        throw new DeployError(
          `${bad.name} is ${bad.status}:\n${(logs.stdout + logs.stderr).trim()}`,
        );
      }
      const healthy = containers.filter(
        (c) => c.status === 'running' && c.health === 'healthy',
      );
      if (healthy.length >= expected && containers.length === healthy.length) {
        return containers;
      }
      if (now() > deadline) {
        throw new DeployError(
          `${service(colour)} not healthy after ${timeoutSeconds}s (${healthy.length}/${expected}); see docker compose logs ${service(colour)}`,
        );
      }
      await sleep(2000);
    }
  }

  /** Every replica answers each path with 2xx on its own port, and the colour's name resolves. */
  async function smoke(colour, containers, paths) {
    const script =
      'const u=process.argv[1];fetch(u).then(r=>{console.log(r.status,u);process.exit(r.ok?0:1)},e=>{console.error(u,e.message);process.exit(1)})';
    const urls = [];
    for (const container of containers) {
      for (const p of paths) {
        urls.push([container, `http://127.0.0.1:3000${p}`]);
      }
    }
    for (const p of paths) {
      urls.push([containers[0], `http://${service(colour)}:3000${p}`]);
    }
    for (const [container, url] of urls) {
      const result = await docker(
        ['exec', container.id, 'node', '-e', script, url],
        {
          allowFail: true,
        },
      );
      if (result.code !== 0) {
        throw new DeployError(
          `smoke check failed in ${container.name}: ${(result.stdout + result.stderr).trim()}`,
        );
      }
    }
    log(`smoke ok: ${paths.join(' ')} on ${containers.length} replica(s)`);
  }

  async function reconnect(config, container, aliases) {
    await docker(['network', 'disconnect', config.edge, container.id]);
    const args = ['network', 'connect'];
    for (const alias of aliases) args.push('--alias', alias);
    await docker([...args, config.edge, container.id]);
  }

  /**
   * Flip the traffic to `target`. The new colour answers to `api` first and
   * Caddy is given `settle` seconds (its DNS refresh is 5) to learn the new
   * addresses; only then does the old one leave `api`. At no moment is `api`
   * empty or listing a container that is gone.
   */
  async function flip(config, state, target, { settle }) {
    const from = other(target);
    const started = now();
    for (const c of state.colours[target]) {
      await reconnect(config, c, ['api', service(target)]);
    }
    log(`${target} answers to api; waiting ${settle}s for Caddy to refresh`);
    await sleep(settle * 1000);
    for (const c of state.colours[from].filter((x) => x.status === 'running')) {
      await reconnect(config, c, [service(from)]);
    }
    const seconds = Math.round((now() - started) / 100) / 10;
    log(`switched to ${target} in ${seconds}s (${from} left api)`);
    return seconds;
  }

  async function ensureStack() {
    await compose(['up', '-d', '--wait', 'postgres', 'redis', 'caddy']);
  }

  async function startWorker(image) {
    log(`worker on ${image}`);
    await compose(['up', '-d', '--no-deps', 'worker'], {
      env: { APP_IMAGE: image },
    });
  }

  async function resolveImage(config, colour, state, options) {
    if (options.build) {
      const tag = `${config.project}-app:bg-${new Date(now()).toISOString().replace(/\D/g, '').slice(0, 14)}`;
      log(`building ${tag}`);
      await compose(['build', service(colour)], {
        env: { [`APP_IMAGE_${colour.toUpperCase()}`]: tag },
        stream: true,
      });
      return tag;
    }
    if (!options.image) {
      throw new DeployError('deploy needs --image <ref> or --build');
    }
    const present = await docker(['image', 'inspect', options.image], {
      allowFail: true,
    });
    if (present.code !== 0) {
      log(`pulling ${options.image}`);
      await docker(['pull', options.image], { stream: true });
    }
    return options.image;
  }

  async function deploy(options) {
    const settle = options.settle ?? 7;
    const config = await readConfig();
    await ensureStack();
    const state = await readState(config);
    const live = state.live;
    const idle = live ? other(live) : 'blue';
    log(`live: ${live ?? 'none'}; deploying to ${idle}`);
    const image = await resolveImage(config, idle, state, options);

    if (!options.noMigrate) {
      log('migrating (expand-only, the live colour keeps serving)');
      await compose(['run', '--rm', '--no-deps', '-T', 'migrate'], {
        env: { APP_IMAGE: image },
        stream: true,
      });
    }

    // The idle colour is recreated on the new image; it joins edge under its own name.
    const env = colourEnv(state, { live, images: { [idle]: image } });
    await compose(
      ['up', '-d', '--no-deps', '--force-recreate', service(idle)],
      { env },
    );
    const containers = await waitHealthy(config, idle, options.timeout ?? 180);
    await smoke(idle, containers, options.smokePaths ?? ['/health']);

    const fresh = await readState(config);
    const seconds = live
      ? await flip(config, fresh, idle, { settle })
      : await firstSwitch(config, fresh, idle);
    if (!options.noWorker) await startWorker(image);
    await finishOld(config, live, options.grace ?? 300);
    return { live: idle, image, previous: live, switchSeconds: seconds };
  }

  /** The very first deploy: nothing to leave, the colour just takes `api`. */
  async function firstSwitch(config, state, colour) {
    for (const c of state.colours[colour]) {
      await reconnect(config, c, ['api', service(colour)]);
    }
    log(`${colour} is live`);
    return 0;
  }

  async function finishOld(config, old, grace) {
    if (!old) return;
    if (grace === 'keep') {
      log(`${old} keeps running: \`switch\` rolls back, \`finish\` stops it`);
      return;
    }
    if (grace > 0) {
      log(`${old} runs ${grace}s more for a rollback, then stops`);
      await sleep(grace * 1000);
      // Rolled back meanwhile: that colour is live again, leave it alone.
      const state = await readState(config);
      if (state.live === old) {
        log(`${old} is live again: not stopped`);
        return;
      }
    }
    await compose(['stop', service(old)]);
    log(`${old} stopped (\`switch\` starts and flips back to it)`);
  }

  async function switchTo(options) {
    const settle = options.settle ?? 7;
    const config = await readConfig();
    const state = await readState(config);
    if (!state.live && !state.both) {
      throw new DeployError('no live colour: deploy first');
    }
    const target = options.to ?? other(state.live);
    if (!COLOURS.includes(target)) throw new DeployError(`--to blue|green`);
    if (state.live === target) {
      log(`${target} is already live`);
      return { live: target, switchSeconds: 0 };
    }
    const existing = state.colours[target];
    if (existing.length === 0) {
      throw new DeployError(
        `${service(target)} has no containers: deploy an image to it (deploy --image <previous image>)`,
      );
    }
    if (existing.some((c) => c.status !== 'running')) {
      log(`starting ${service(target)}`);
      await compose(['start', service(target)]);
    }
    const containers = await waitHealthy(
      config,
      target,
      options.timeout ?? 180,
    );
    await smoke(target, containers, options.smokePaths ?? ['/health']);
    const fresh = await readState(config);
    const seconds = await flip(config, fresh, target, { settle });
    if (!options.noWorker) {
      const image = imageOf(fresh.colours[target]);
      await startWorker(image);
    }
    log(`${other(target)} keeps running; \`finish\` stops it`);
    return { live: target, previous: other(target), switchSeconds: seconds };
  }

  async function finish() {
    const config = await readConfig();
    const state = await readState(config);
    if (!state.live)
      throw new DeployError('no single live colour: nothing to finish');
    const idle = other(state.live);
    await compose(['stop', service(idle)]);
    log(`${idle} stopped; ${state.live} is live`);
    return { live: state.live };
  }

  return { status, deploy, switchTo, finish };
}

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: 'string', short: 'p' },
      file: { type: 'string', short: 'f', multiple: true },
      'env-file': { type: 'string', multiple: true },
      image: { type: 'string' },
      build: { type: 'boolean' },
      to: { type: 'string' },
      'smoke-path': { type: 'string', multiple: true },
      timeout: { type: 'string' },
      settle: { type: 'string' },
      grace: { type: 'string' },
      'no-migrate': { type: 'boolean' },
      'no-worker': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const flags = [];
  for (const f of values.file ?? []) flags.push('-f', f);
  for (const f of values['env-file'] ?? []) flags.push('--env-file', f);
  if (values.project) flags.push('-p', values.project);
  const number = (v, name) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0)
      throw new DeployError(`${name} must be a number of seconds`);
    return n;
  };
  return {
    command: positionals[0] ?? 'status',
    flags,
    options: {
      image: values.image,
      build: values.build,
      to: values.to,
      smokePaths: values['smoke-path'],
      timeout: number(values.timeout, '--timeout'),
      settle: number(values.settle, '--settle'),
      grace: values.grace === 'keep' ? 'keep' : number(values.grace, '--grace'),
      noMigrate: values['no-migrate'],
      noWorker: values['no-worker'],
      json: values.json,
    },
    help: values.help,
  };
}

export async function main(argv, deps = {}) {
  const { command, flags, options, help } = parse(argv);
  if (help) {
    log_help();
    return 0;
  }
  const deployer = createDeployer({ ...deps, compose: flags });
  try {
    if (command === 'status') {
      const result = await deployer.status({ json: options.json });
      if (options.json) console.log(JSON.stringify(result, null, 2));
    } else if (command === 'deploy') {
      await deployer.deploy(options);
    } else if (command === 'switch' || command === 'rollback') {
      await deployer.switchTo(options);
    } else if (command === 'finish') {
      await deployer.finish();
    } else {
      throw new DeployError(
        `unknown command ${command}: status, deploy, switch, rollback, finish`,
      );
    }
    return 0;
  } catch (error) {
    if (!(error instanceof DeployError)) throw error;
    console.error(`deploy:blue-green: ${error.message}`);
    return 1;
  }
}

function log_help() {
  console.error(
    'usage: pnpm deploy:blue-green <status|deploy|switch|rollback|finish> [options]\n' +
      'see the header of tools/deploy/blue-green.mjs and docs/deploy-blue-green.md',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
