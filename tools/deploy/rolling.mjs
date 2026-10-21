// A rolling deploy of the Compose production stack, without downtime
// (docs/deploy-rolling.md):
//
//   pnpm deploy:rolling [--services api,worker] [--skip-build] [--skip-migrate]
//                       [--health-timeout 120] [--settle 10] [-p name] [-f file]... [--env-file file]
//
// 1. builds the images (or pulls APP_IMAGE's), 2. runs the `migrate` service
// (expand-only migrations: the old containers keep serving the new schema),
// 3. per service: starts as many new containers as there are old ones next to
// them, waits until the new ones are healthy and Caddy has had time to
// discover them, then stops and removes the OLD ones by id, so the count is
// back to what it was. A new container that doesn't become healthy aborts the
// deploy: the new ones are removed, the old keep serving.
//
// Plain ESM, no dependency. Every docker call goes through an injectable
// `run(args)`, so the tests (rolling.test.mjs) need no Docker.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { verifyIfEnabled } from './verify.mjs';

export const DEFAULTS = {
  services: ['api', 'worker'],
  build: true,
  migrate: true,
  healthTimeoutS: 120,
  // Caddy re-reads the api replicas' DNS every 5 s and health-checks them
  // every 5 s (caddy/Caddyfile): the old ones stay until the new are routed.
  settleS: 10,
  pollMs: 1000,
  project: undefined,
  files: [],
  envFile: undefined,
};

export class DeployError extends Error {}

/** The docker CLI: resolves { code, stdout, stderr }, never rejects on a non-zero exit. */
export function dockerRunner(cwd = process.cwd()) {
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn('docker', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => {
        stderr += d;
        process.stderr.write(d);
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

export function parseArgs(argv) {
  const o = { ...DEFAULTS, files: [] };
  const value = (i, flag) => {
    if (argv[i + 1] === undefined)
      throw new DeployError(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--services')
      o.services = value(i++, a).split(',').filter(Boolean);
    else if (a === '--skip-build') o.build = false;
    else if (a === '--skip-migrate') o.migrate = false;
    else if (a === '--health-timeout') o.healthTimeoutS = Number(value(i++, a));
    else if (a === '--settle') o.settleS = Number(value(i++, a));
    else if (a === '-p' || a === '--project') o.project = value(i++, a);
    else if (a === '-f' || a === '--file') o.files.push(value(i++, a));
    else if (a === '--env-file') o.envFile = value(i++, a);
    else throw new DeployError(`unknown option ${a}`);
  }
  if (o.services.length === 0) throw new DeployError('no services to deploy');
  for (const n of [o.healthTimeoutS, o.settleS]) {
    if (!Number.isFinite(n) || n < 0)
      throw new DeployError('times are seconds >= 0');
  }
  return o;
}

/**
 * @param {object} o parseArgs() options
 * @param {{ run: Function, log?: Function, sleep?: Function, env?: object, now?: Function }} deps
 */
export async function rollingDeploy(o, deps) {
  const { run, log = console.log, sleep = delay, env = process.env } = deps;
  const now = deps.now ?? Date.now;
  const compose = (...args) => [
    'compose',
    ...(o.envFile ? ['--env-file', o.envFile] : []),
    ...(o.project ? ['-p', o.project] : []),
    ...o.files.flatMap((f) => ['-f', f]),
    ...args,
  ];
  const ok = async (args, what) => {
    const r = await run(args);
    if (r.code !== 0) throw new DeployError(`${what} failed (exit ${r.code})`);
    return r.stdout;
  };
  const ids = async (service) =>
    (await ok(compose('ps', '-q', '--all', service), `listing ${service}`))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  const state = async (id) => {
    const r = await run(['inspect', '--format', '{{json .State}}', id]);
    if (r.code !== 0) return { Status: 'missing' };
    return JSON.parse(r.stdout);
  };
  const removeAll = async (list) => {
    if (list.length > 0) await run(['rm', '-f', ...list]);
  };

  const buildServices = ['migrate', ...o.services];
  if (o.build) {
    // A published image (APP_IMAGE, set by CI) is pulled, a local one built.
    if (env.APP_IMAGE) {
      // VERIFY_IMAGES=1: signature, SBOM and provenance first (off by default).
      await verifyIfEnabled(
        { env, log, verify: deps.verify },
        (m) => new DeployError(m),
      );
      log(`Pulling ${env.APP_IMAGE}`);
      await ok(compose('pull', ...buildServices), 'pull');
    } else {
      log('Building the images');
      await ok(compose('build', ...buildServices), 'build');
    }
  }
  // The stores the app needs (a no-op when they run).
  await ok(
    compose('up', '-d', '--wait', 'postgres', 'redis'),
    'starting postgres and redis',
  );
  if (o.migrate) {
    log(
      'Running migrations (expand-only: the running version must work on the new schema)',
    );
    await ok(compose('run', '--rm', '--no-deps', 'migrate'), 'migrate');
  }

  for (const service of o.services) {
    const old = await ids(service);
    if (old.length === 0) {
      log(`${service}: not running, starting it`);
      await ok(
        compose('up', '-d', '--no-deps', service),
        `starting ${service}`,
      );
      continue;
    }
    const n = old.length;
    log(`${service}: ${n} running, starting ${n} new next to them`);
    await ok(
      compose(
        'up',
        '-d',
        '--no-deps',
        '--no-recreate',
        '--scale',
        `${service}=${2 * n}`,
        service,
      ),
      `scaling ${service}`,
    );
    const fresh = (await ids(service)).filter((id) => !old.includes(id));
    if (fresh.length < n) {
      await removeAll(fresh);
      throw new DeployError(
        `${service}: ${fresh.length} of ${n} new containers started; old ones untouched`,
      );
    }

    const deadline = now() + o.healthTimeoutS * 1000;
    const pending = new Set(fresh);
    while (pending.size > 0) {
      for (const id of [...pending]) {
        const s = await state(id);
        const health = s.Health?.Status;
        if (
          ['exited', 'dead', 'missing'].includes(s.Status) ||
          health === 'unhealthy'
        ) {
          await removeAll(fresh);
          throw new DeployError(
            `${service}: new container ${id.slice(0, 12)} is ${health ?? s.Status}; removed the new ones, the old keep serving`,
          );
        }
        // Without a healthcheck the best signal is "running".
        if (
          health === 'healthy' ||
          (health === undefined && s.Status === 'running')
        )
          pending.delete(id);
      }
      if (pending.size === 0) break;
      if (now() > deadline) {
        await removeAll(fresh);
        throw new DeployError(
          `${service}: new containers not healthy after ${o.healthTimeoutS} s; removed them, the old keep serving`,
        );
      }
      await sleep(o.pollMs);
    }
    log(
      `${service}: the new containers are healthy; waiting ${o.settleS} s for the proxy to route them`,
    );
    await sleep(o.settleS * 1000);

    // By id: scaling down would pick the highest numbers, i.e. the new ones.
    // `docker stop` honours each container's stop_grace_period (SIGTERM first).
    log(`${service}: stopping the ${n} old container(s) (graceful)`);
    await Promise.all(old.map((id) => run(['stop', id])));
    await removeAll(old);
    log(`${service}: done`);
  }
  log('Deployed.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await rollingDeploy(parseArgs(process.argv.slice(2)), {
      run: dockerRunner(),
    });
  } catch (e) {
    console.error(
      e instanceof DeployError ? `deploy:rolling: ${e.message}` : e,
    );
    process.exit(1);
  }
}
