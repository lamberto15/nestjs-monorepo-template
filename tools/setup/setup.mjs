#!/usr/bin/env node
// The first-run wizard: asks the few questions that shape a project (one
// organization or many, mail, storage, sign-up, bot protection, ...), then
// writes its env file from the template, with every secret generated. The
// deployment shape (TENANCY) is chosen once, here. Idle features stay off.
//
//   pnpm setup                                   # asks; development or production
//   pnpm setup --target production --tenancy single --mail smtp --smtp-url "smtp://…" --yes
//   pnpm setup --dry-run --yes                   # the plan (secrets masked), nothing written
//   pnpm setup --rotate                          # new secrets in an existing file
//   node --test tools/setup/setup.test.mjs       # its tests
//
// Development writes apps/api/.env.development (from env.development.example),
// production the root .env (from env.example, chmod 600). An existing file is
// the default of every question, its secrets are kept (unless --rotate), a
// masked diff is shown before anything is written, and `<file>.bak` keeps
// the old one. Which variables each answer sets: plan.mjs.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  applies,
  buildPlan,
  choicesOf,
  defaultFor,
  diffValues,
  mask,
  QUESTIONS,
} from './plan.mjs';
import {
  applyValues,
  parseEnv,
  stripFeatureBlocks,
  templateKeys,
} from './envfile.mjs';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** Where each target's template is and its file goes, relative to the root. */
const TARGETS = {
  development: {
    template: 'apps/api/env.development.example',
    file: 'apps/api/.env.development',
  },
  production: { template: 'env.example', file: '.env' },
};

const kebab = (id) => id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const USAGE = `pnpm setup [--target development|production] [options]

  --yes, -y        take the defaults and the flags below, ask nothing
  --dry-run        print the plan (secrets masked), write nothing
  --rotate         new secrets in an existing file (keys are put in front of the old ones)
  --root <dir>     the repository (default: this one); --out <dir>: write the file there

One flag per question (with --yes a required one missing is an error):
${QUESTIONS.map((q) => `  --${kebab(q.id)}${q.type === 'bool' ? ' / --no-' + kebab(q.id) : ' <value>'}`.padEnd(34) + q.label).join('\n')}`;

/** The options parseArgs takes: the fixed ones, and one per question. */
function optionsSpec() {
  const options = {
    target: { type: 'string' },
    yes: { type: 'boolean', short: 'y', default: false },
    'dry-run': { type: 'boolean', default: false },
    rotate: { type: 'boolean', default: false },
    root: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  };
  for (const q of QUESTIONS) {
    options[kebab(q.id)] = { type: q.type === 'bool' ? 'boolean' : 'string' };
  }
  return options;
}

/** The answer a flag gives, checked like an asked one; throws naming the flag. */
function checkFlag(q, raw, ctx) {
  const flag = `--${kebab(q.id)}`;
  if (q.type === 'bool') return raw;
  const value = raw.trim();
  if (q.type === 'choice' && !choicesOf(q, ctx).includes(value)) {
    throw new Error(`${flag}: one of ${choicesOf(q, ctx).join(', ')}.`);
  }
  const problem = q.type === 'text' ? q.validate?.(value) : null;
  if (problem) throw new Error(`${flag}: ${problem}.`);
  return value;
}

/** An answer typed at the prompt: { value } or { error }. */
function parseAnswer(q, input, def, ctx) {
  const text = input.trim();
  if (q.type === 'bool') {
    if (text === '')
      return def === undefined ? { error: 'y or n' } : { value: def };
    if (/^(y|yes|on|true)$/i.test(text)) return { value: true };
    if (/^(n|no|off|false)$/i.test(text)) return { value: false };
    return { error: 'y or n' };
  }
  if (q.type === 'choice') {
    if (text === '' && def !== undefined) return { value: def };
    return choicesOf(q, ctx).includes(text)
      ? { value: text }
      : { error: `one of ${choicesOf(q, ctx).join(', ')}` };
  }
  // Text: empty keeps the default, "-" empties it.
  let value = text === '' ? (def ?? '') : text === '-' ? '' : text;
  if (q.required && value === '') return { error: 'a value is needed' };
  const problem = q.validate?.(value);
  return problem ? { error: problem } : { value };
}

/** The question's line at the prompt. */
function promptLine(q, def, ctx) {
  const shown =
    def === undefined || def === ''
      ? ''
      : q.secret
        ? ' [keep current]'
        : ` [${q.type === 'bool' ? (def ? 'y' : 'n') : def}]`;
  const options =
    q.type === 'choice'
      ? ` (${choicesOf(q, ctx).join('/')})`
      : q.type === 'bool'
        ? ' (y/n)'
        : '';
  return `${q.label}${options}${shown}: `;
}

/**
 * Runs the wizard. `io` is for tests: { isTTY, ask(line) => answer,
 * runRemove(root) => exit code, out, err }. Returns the exit code.
 */
export async function run(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));
  const isTTY = io.isTTY ?? Boolean(process.stdin.isTTY);
  const { values } = parseArgs({
    args: argv,
    options: optionsSpec(),
    allowNegative: true,
  });
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (!values.yes && !isTTY) {
    err(
      'pnpm setup asks questions and needs a terminal. Run it in one, or pass --yes (the defaults and the flags; --help lists them).',
    );
    return 1;
  }
  let rl;
  const ask =
    io.ask ??
    (async (line) => {
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      return rl.question(line);
    });
  try {
    return await wizard(values, { out, err, ask, runRemove: io.runRemove });
  } finally {
    rl?.close();
  }
}

async function wizard(values, io) {
  const { out, err, ask } = io;
  const interactive = !values.yes;
  const dryRun = values['dry-run'];

  let target = values.target;
  if (target !== undefined && !TARGETS[target]) {
    throw new Error('--target: development or production.');
  }
  while (target === undefined) {
    if (!interactive) {
      target = 'development';
      break;
    }
    const input = (
      await ask('Set up for development or production? [development]: ')
    ).trim();
    if (input === '' || TARGETS[input]) target = input || 'development';
    else err('  development or production');
  }

  const root = path.resolve(values.root ?? REPO);
  const files = TARGETS[target];
  const templatePath = path.join(root, files.template);
  const filePath = values.out
    ? path.join(path.resolve(values.out), path.basename(files.file))
    : path.join(root, files.file);
  if (!existsSync(templatePath)) {
    throw new Error(`The template ${files.template} is not under ${root}.`);
  }
  const templateText = readFileSync(templatePath, 'utf8');
  const existingText = existsSync(filePath)
    ? readFileSync(filePath, 'utf8')
    : null;
  const tpl = parseEnv(templateText);
  const existing = existingText === null ? null : parseEnv(existingText);
  const ctx = {
    target,
    tpl,
    keys: templateKeys(templateText),
    existing,
    current: existing ?? tpl,
    hasNotes: existsSync(path.join(root, 'apps/api/src/features/notes')),
  };

  out(
    existing
      ? `${path.relative(process.cwd(), filePath) || filePath} exists: its values are the defaults, its secrets are kept${values.rotate ? ' except with --rotate' : ''}.`
      : `Setting up ${target}: ${path.relative(process.cwd(), filePath) || filePath}`,
  );

  // The questions, in order.
  const answers = {};
  const missing = [];
  for (const q of QUESTIONS) {
    if (!applies(q, answers, ctx)) continue;
    const given = values[kebab(q.id)];
    const def = defaultFor(q, answers, ctx);
    if (given !== undefined) {
      answers[q.id] = checkFlag(q, given, ctx);
      continue;
    }
    if (interactive) {
      if (q.hint) out(`  ${q.hint}`);
      for (;;) {
        const input = await ask(promptLine(q, def, ctx));
        const result = parseAnswer(q, input, def, ctx);
        if ('value' in result) {
          answers[q.id] = result.value;
          break;
        }
        err(`  ${result.error}`);
      }
      continue;
    }
    answers[q.id] = q.type === 'text' ? (def ?? '') : def;
    if (q.required && !answers[q.id]) missing.push(`--${kebab(q.id)}`);
  }
  if (missing.length && !dryRun) {
    throw new Error(
      `A value is needed for ${missing.join(', ')} (pass the flag${missing.length > 1 ? 's' : ''}).`,
    );
  }

  const plan = buildPlan({ answers, ctx, rotate: values.rotate });
  const changes = diffValues(ctx.current, plan.values);
  for (const warning of plan.warnings) err(`WARNING: ${warning}`);
  if (missing.length) {
    err(
      `NOT WRITTEN without --dry-run: a value is needed for ${missing.join(', ')}.`,
    );
  }

  out(
    changes.length
      ? `\n${dryRun ? 'Plan' : 'Changes'} for ${files.file} (secrets masked):`
      : '\nNothing to change in the file.',
  );
  for (const { key, from, to } of changes) {
    out(
      from === ''
        ? `  + ${key}=${mask(key, to)}`
        : `  ~ ${key}: ${mask(key, from)} -> ${mask(key, to)}`,
    );
  }
  const removeNotes = answers.removeNotes === true;
  if (removeNotes)
    out('  Remove the example feature: pnpm feature:remove notes');
  if (dryRun) {
    out('\nDry run: nothing written.');
    return 0;
  }
  if (interactive && (changes.length || removeNotes)) {
    const answer = (await ask(`\nWrite ${files.file}? [Y/n]: `)).trim();
    if (/^n/i.test(answer)) {
      out('Nothing written.');
      return 0;
    }
  }

  // Write: the old file to .bak first; an existing file is the base, so
  // the owner's other lines stay.
  let text = existingText ?? templateText;
  if (removeNotes) text = stripFeatureBlocks(text, 'notes');
  text = applyValues(text, plan.values);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const mode = target === 'production' ? 0o600 : 0o644;
  if (existingText !== null) {
    copyFileSync(filePath, `${filePath}.bak`);
    chmodSync(`${filePath}.bak`, mode);
  }
  writeFileSync(filePath, text, { mode });
  chmodSync(filePath, mode);
  out(
    `\nWrote ${filePath}${existingText === null ? '' : ` (the old one: ${filePath}.bak)`}.`,
  );
  if (plan.generated.length) {
    out(
      `Generated ${plan.generated.length} secrets: ${plan.generated.join(', ')} (not shown).`,
    );
  }
  if (plan.adminPassword) {
    out(
      // Never printed: terminals and CI logs keep what they show.
      `\nFirst administrator: ${answers.adminEmail}\nPassword: generated, ADMIN_PASSWORD in ${files.file} (read it there, then change it after the first sign-in).`,
    );
  }

  if (removeNotes) {
    const code = (io.runRemove ?? runRemove)(root);
    if (code !== 0) return code;
    out(
      '\nNext: pnpm db:generate (drops the notes tables), then pnpm client:generate.',
    );
  }
  out(
    target === 'production'
      ? '\nNext: docker compose up -d --build (docs/deployment.md).'
      : '\nNext: pnpm services:up && pnpm start:dev (docs/development.md).',
  );
  return 0;
}

/** `pnpm feature:remove notes` on the checkout at `root`. */
function runRemove(root) {
  const result = spawnSync(
    process.execPath,
    [path.join(REPO, 'tools/feature/remove.mjs'), 'notes', '--root', root],
    { stdio: 'inherit' },
  );
  return result.status ?? 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
