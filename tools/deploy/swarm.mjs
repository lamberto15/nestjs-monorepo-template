#!/usr/bin/env node
// Deploys the production stack to Docker Swarm (docs/deploy-swarm.md):
//
//   pnpm deploy:swarm [deploy]   validate, migrate, deploy, wait; a failed
//                                update rolls back by itself (compose.swarm.yaml)
//   pnpm deploy:swarm check      render and validate the stack file only
//   pnpm deploy:swarm render     print the stack file
//   pnpm deploy:swarm status     the services and the state of their last update
//   pnpm deploy:swarm rollback   `docker service rollback` of api and worker
//
// Options: --stack <name> (SWARM_STACK, default "app"), --env-file <path>
// (Compose's, instead of ./.env), --timeout <seconds> (default 600),
// --service <name> (rollback; repeatable), --prune (remove services the stack
// file no longer has), --skip-migrate.
//
// Docker is reached through an injectable runner, so the tests (swarm.test.mjs)
// run the whole flow against a fake.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toStack } from './render.mjs';
import { verifyIfEnabled } from './verify.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE_FILES = [
  'compose.yaml',
  'compose.prod.yaml',
  'compose.swarm.yaml',
];
const TERMINAL_OK = new Set(['completed']);
const TERMINAL_ROLLED_BACK = new Set(['rollback_completed']);
const TERMINAL_STUCK = new Set(['paused', 'rollback_paused']);

/** The real runner: runs a command, collects its output, never throws. */
export function spawnRunner(command, args, { input, env, cwd } = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { env: env ?? process.env, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) =>
      done({ code: 127, stdout, stderr: String(error) }),
    );
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export function parseArgs(argv) {
  const options = {
    command: 'deploy',
    services: [],
    prune: false,
    skipMigrate: false,
  };
  const rest = [...argv];
  const take = (flag) => {
    const value = rest.shift();
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    return value;
  };
  let commandSeen = false;
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === '--stack') options.stack = take(arg);
    else if (arg === '--env-file') options.envFile = take(arg);
    else if (arg === '--timeout') options.timeout = Number(take(arg));
    else if (arg === '--service') options.services.push(take(arg));
    else if (arg === '--prune') options.prune = true;
    else if (arg === '--skip-migrate') options.skipMigrate = true;
    else if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`);
    else if (!commandSeen) {
      options.command = arg;
      commandSeen = true;
    } else throw new UsageError(`unexpected argument ${arg}`);
  }
  if (options.timeout !== undefined && !(options.timeout > 0)) {
    throw new UsageError('--timeout is a number of seconds');
  }
  return options;
}

export class UsageError extends Error {}
class DeployError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.exitCode = code;
  }
}

/**
 * @param {string[]} argv
 * @param {object} [deps]  runner, env, log, sleep, now, readFile, exists: the tests' fakes
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  try {
    const options = parseArgs(argv);
    const ctx = {
      run: deps.runner ?? spawnRunner,
      env: deps.env ?? process.env,
      log,
      sleep:
        deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
      now: deps.now ?? (() => Date.now()),
      readFile: deps.readFile ?? ((path) => readFileSync(path)),
      exists: deps.exists ?? ((path) => existsSync(path)),
      root: deps.root ?? root,
      pollMs: deps.pollMs ?? 2000,
      graceMs: deps.graceMs ?? 20000,
      stack: options.stack ?? (deps.env ?? process.env).SWARM_STACK ?? 'app',
      verify: deps.verify,
      options,
    };
    ctx.timeoutMs = (options.timeout ?? 600) * 1000;
    const commands = { deploy, check, render, status, rollback };
    const command = commands[options.command];
    if (!command) throw new UsageError(`unknown command ${options.command}`);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(ctx.stack)) {
      throw new UsageError(
        `stack name ${ctx.stack}: lowercase letters, digits, - and _`,
      );
    }
    return await command(ctx);
  } catch (error) {
    if (error instanceof UsageError) {
      log(`deploy:swarm: ${error.message}`);
      log(
        'usage: deploy:swarm [deploy|check|render|status|rollback] [--stack n] [--env-file f] [--timeout s] [--service s] [--prune] [--skip-migrate]',
      );
      return 2;
    }
    if (error instanceof DeployError) {
      log(`deploy:swarm: ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }
}

// --- Docker -----------------------------------------------------------------

async function docker(ctx, args, options = {}) {
  const result = await ctx.run('docker', args, {
    env: ctx.env,
    cwd: ctx.root,
    ...options,
  });
  if (result.code !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout).trim();
    throw new DeployError(
      `docker ${args.slice(0, 3).join(' ')} failed (${result.code}): ${detail}`,
    );
  }
  return result;
}

/** The stack file as an object: Compose renders, render.mjs adapts. */
async function renderStack(ctx, { app }) {
  const args = ['compose', '--project-directory', ctx.root, '-p', ctx.stack];
  if (ctx.options.envFile)
    args.push('--env-file', resolve(ctx.options.envFile));
  for (const file of COMPOSE_FILES) args.push('-f', join(ctx.root, file));
  if (app) args.push('--profile', 'app');
  args.push('config', '--format', 'json');
  // An .env's COMPOSE_FILE/COMPOSE_PROFILES would add to ours.
  const env = { ...ctx.env };
  delete env.COMPOSE_FILE;
  delete env.COMPOSE_PROFILES;
  const result = await docker(ctx, args, { env });
  const rendered = JSON.parse(result.stdout);
  return toStack(rendered, {
    stack: ctx.stack,
    readFile: ctx.readFile,
    placeholder: join(ctx.root, 'swarm.placeholder'),
  });
}

async function validate(ctx, stackFile) {
  await docker(ctx, ['stack', 'config', '-c', '-'], {
    input: JSON.stringify(stackFile),
  });
}

async function inspectService(ctx, name) {
  const result = await docker(ctx, ['service', 'inspect', name], {
    allowFailure: true,
  });
  if (result.code !== 0) return null;
  const [service] = JSON.parse(result.stdout);
  return service ?? null;
}

async function replicas(ctx) {
  const result = await docker(ctx, [
    'service',
    'ls',
    '--filter',
    `label=com.docker.stack.namespace=${ctx.stack}`,
    '--format',
    '{{.Name}}|{{.Replicas}}',
  ]);
  const map = new Map();
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const [name, value] = line.split('|');
    const match = /^(\d+)\/(\d+)/.exec(value ?? '');
    if (match)
      map.set(name, { running: Number(match[1]), wanted: Number(match[2]) });
  }
  return map;
}

// --- Commands ---------------------------------------------------------------

async function check(ctx) {
  const stackFile = await renderStack(ctx, { app: true });
  await validate(ctx, stackFile);
  ctx.log(
    `stack file valid: ${Object.keys(stackFile.services).length} services`,
  );
  return 0;
}

async function render(ctx) {
  const stackFile = await renderStack(ctx, { app: true });
  ctx.log(JSON.stringify(stackFile, null, 2));
  return 0;
}

/** Swarm active here, a manager, and a node for every `node.labels.x == y` constraint. */
export async function preflight(ctx, stackFile) {
  const info = await docker(ctx, ['info', '--format', '{{json .Swarm}}']);
  const swarm = JSON.parse(info.stdout);
  if (swarm.LocalNodeState !== 'active' || !swarm.ControlAvailable) {
    throw new DeployError(
      'this Docker is not a Swarm manager: `docker swarm init` (or run this on a manager)',
    );
  }
  const wanted = new Map();
  for (const service of Object.values(stackFile.services)) {
    for (const constraint of service.deploy?.placement?.constraints ?? []) {
      const match = /^node\.labels\.([\w.-]+)\s*==\s*(.+)$/.exec(
        constraint.trim(),
      );
      if (match) wanted.set(constraint.trim(), [match[1], match[2].trim()]);
    }
  }
  if (wanted.size === 0) return;
  const ids = (await docker(ctx, ['node', 'ls', '-q'])).stdout
    .split('\n')
    .filter(Boolean);
  const labels = [];
  for (const id of ids) {
    const result = await docker(ctx, [
      'node',
      'inspect',
      '--format',
      '{{json .Spec.Labels}}',
      id,
    ]);
    labels.push({ id, labels: JSON.parse(result.stdout.trim() || '{}') ?? {} });
  }
  for (const [constraint, [key, value]] of wanted) {
    if (!labels.some((node) => node.labels[key] === value)) {
      throw new DeployError(
        `no node matches ${constraint} (PostgreSQL, Redis and Caddy keep local data there). ` +
          `Label one: docker node update --label-add ${key}=${value} <node>`,
      );
    }
  }
}

async function deploy(ctx) {
  const deployId = ctx.env.SWARM_DEPLOY_ID || String(ctx.now());
  // The same in both renders: the migrate job's spec (so its rerun) changes once per deploy.
  ctx.env = { ...ctx.env, SWARM_DEPLOY_ID: deployId };

  // VERIFY_IMAGES=1: signature, SBOM and provenance first (off by default).
  await verifyIfEnabled(ctx, (m) => new DeployError(m));

  ctx.log(`rendering ${ctx.stack}`);
  const infra = await renderStack(ctx, { app: false });
  const full = await renderStack(ctx, { app: true });
  await validate(ctx, full);
  await preflight(ctx, full);

  const deployArgs = [
    'stack',
    'deploy',
    '--with-registry-auth',
    '--detach=true',
    '-c',
    '-',
  ];
  if (ctx.options.prune) deployArgs.push('--prune');
  deployArgs.push(ctx.stack);

  // 1. Everything but the app (PostgreSQL, Redis, ...) and the migrations as a job.
  if (!ctx.options.skipMigrate) {
    const migrateName = `${ctx.stack}_migrate`;
    const known = await taskIds(ctx, migrateName);
    ctx.log('deploying the stores and running the migrations');
    await docker(ctx, deployArgs, { input: JSON.stringify(infra) });
    await waitForMigration(ctx, migrateName, known, infra.services.migrate);
    ctx.log('migrations done');
  }

  // 2. The app: api and worker roll one task at a time, start-first.
  const waited = Object.keys(full.services).filter(
    (name) => name !== 'migrate',
  );
  const before = new Map();
  for (const name of waited) {
    const service = await inspectService(ctx, `${ctx.stack}_${name}`);
    before.set(name, {
      startedAt: service?.UpdateStatus?.StartedAt,
      image: imageOf(service),
    });
  }
  ctx.log('deploying the stack');
  await docker(ctx, deployArgs, { input: JSON.stringify(full) });
  const startedAt = ctx.now();

  const outcomes = await waitForServices(ctx, waited, before, startedAt);
  return report(ctx, outcomes);
}

function imageOf(service) {
  return service?.Spec?.TaskTemplate?.ContainerSpec?.Image;
}

async function taskIds(ctx, service) {
  const result = await docker(
    ctx,
    ['service', 'ps', '--no-trunc', '-q', service],
    {
      allowFailure: true,
    },
  );
  return new Set(
    result.code === 0 ? result.stdout.split('\n').filter(Boolean) : [],
  );
}

/** The job's new tasks (not in `known`): Complete is done, enough failed ones is an error. */
async function waitForMigration(ctx, name, known, spec) {
  const attempts = spec?.deploy?.restart_policy?.max_attempts ?? 1;
  const deadline = ctx.now() + ctx.timeoutMs;
  let lastError = '';
  while (ctx.now() < deadline) {
    const result = await docker(
      ctx,
      [
        'service',
        'ps',
        '--no-trunc',
        '--format',
        '{{.ID}}|{{.CurrentState}}|{{.Error}}',
        name,
      ],
      { allowFailure: true },
    );
    const fresh = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('|'))
      .filter(([id]) => !known.has(id));
    if (fresh.some(([, state]) => state.startsWith('Complete'))) return;
    const failed = fresh.filter(([, state]) =>
      /^(Failed|Rejected)/.test(state),
    );
    const error = failed[0]?.[2];
    if (error && error !== lastError) {
      lastError = error;
      ctx.log(`migrate attempt failed: ${error}`);
    }
    if (failed.length >= attempts) {
      throw new DeployError(
        `the migrations failed ${failed.length} times; nothing of the app was updated. ` +
          `Logs: docker service logs ${name}`,
      );
    }
    await ctx.sleep(ctx.pollMs);
  }
  throw new DeployError(
    `the migrations did not finish within ${ctx.timeoutMs / 1000}s`,
  );
}

/**
 * Per service: ok, rolled-back, stuck (paused) or timeout. A service
 * whose update status didn't change after `graceMs` wasn't touched by this
 * deploy: it only has to be at its replica count.
 */
async function waitForServices(ctx, names, before, startedAt) {
  const outcomes = new Map();
  const deadline = startedAt + ctx.timeoutMs;
  while (outcomes.size < names.length && ctx.now() < deadline) {
    const counts = await replicas(ctx);
    for (const name of names) {
      if (outcomes.has(name)) continue;
      const full = `${ctx.stack}_${name}`;
      const service = await inspectService(ctx, full);
      if (!service) continue;
      const status = service.UpdateStatus;
      const previous = before.get(name);
      const touched = status && status.StartedAt !== previous?.startedAt;
      const count = counts.get(full);
      const converged = count && count.running === count.wanted;
      if (touched && TERMINAL_ROLLED_BACK.has(status.State)) {
        outcomes.set(name, { state: 'rolled-back', message: status.Message });
      } else if (touched && TERMINAL_STUCK.has(status.State)) {
        outcomes.set(name, { state: 'paused', message: status.Message });
      } else if (touched && status.State === 'completed' && converged) {
        outcomes.set(name, { state: 'ok', message: 'updated' });
      } else if (
        !touched &&
        converged &&
        ctx.now() - startedAt >= ctx.graceMs
      ) {
        outcomes.set(name, { state: 'ok', message: 'unchanged' });
      } else if (!status && converged) {
        outcomes.set(name, { state: 'ok', message: 'running' });
      }
    }
    if (outcomes.size < names.length) await ctx.sleep(ctx.pollMs);
  }
  for (const name of names) {
    if (!outcomes.has(name)) {
      outcomes.set(name, {
        state: 'timeout',
        message: `not converged in ${ctx.timeoutMs / 1000}s`,
      });
    }
  }
  return outcomes;
}

async function failureLines(ctx, name) {
  const result = await docker(
    ctx,
    [
      'service',
      'ps',
      '--no-trunc',
      '--filter',
      'desired-state=shutdown',
      '--format',
      '{{.Image}}|{{.CurrentState}}|{{.Error}}',
      `${ctx.stack}_${name}`,
    ],
    { allowFailure: true },
  );
  return result.stdout
    .split('\n')
    .filter((line) => line.split('|')[2])
    .slice(0, 3);
}

async function report(ctx, outcomes) {
  let code = 0;
  for (const [name, outcome] of outcomes) {
    ctx.log(
      `${name}: ${outcome.state}${outcome.message ? ` (${outcome.message})` : ''}`,
    );
    if (outcome.state === 'ok') continue;
    code = outcome.state === 'rolled-back' ? Math.max(code, 1) : 3;
    for (const line of await failureLines(ctx, name))
      ctx.log(`  failed task: ${line}`);
  }
  if (code === 1) ctx.log('the update was rolled back to the previous version');
  if (code === 3)
    ctx.log('the update needs attention: pnpm deploy:swarm status');
  if (code === 0) ctx.log('deployed');
  return code;
}

async function status(ctx) {
  const services = await docker(ctx, ['stack', 'services', ctx.stack]);
  ctx.log(services.stdout.trimEnd());
  const names = (
    await docker(ctx, [
      'service',
      'ls',
      '--filter',
      `label=com.docker.stack.namespace=${ctx.stack}`,
      '--format',
      '{{.Name}}',
    ])
  ).stdout
    .split('\n')
    .filter(Boolean);
  for (const name of names) {
    const service = await inspectService(ctx, name);
    const update = service?.UpdateStatus;
    if (update)
      ctx.log(
        `${name}: update ${update.State}${update.Message ? `: ${update.Message}` : ''}`,
      );
  }
  return 0;
}

async function rollback(ctx) {
  const names =
    ctx.options.services.length > 0 ? ctx.options.services : ['api', 'worker'];
  let code = 0;
  for (const name of names) {
    const full = `${ctx.stack}_${name}`;
    const service = await inspectService(ctx, full);
    if (!service) throw new DeployError(`no service ${full}`);
    if (!service.PreviousSpec) {
      ctx.log(`${name}: no previous version to roll back to`);
      code = 1;
      continue;
    }
    ctx.log(`${name}: rolling back from ${imageOf(service)}`);
    await docker(ctx, ['service', 'rollback', '--detach=false', full]);
  }
  ctx.log(
    'rolled back; the database is not (expand/contract migrations keep the old version working)',
  );
  return code;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2));
}
