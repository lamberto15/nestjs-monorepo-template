import { readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { appPath } from '../../app-dir.js';

/**
 * Secrets from files: every variable declared with `secret()` (env.helpers.ts)
 * can be given as `X_FILE`, the path of a file holding its value (a Docker
 * secret at /run/secrets/…, a mounted Kubernetes secret, a file a vault
 * agent writes). The file comes first, the variable is the fallback; both
 * set is an error, so a stale value never wins silently.
 *
 * Custom code, run as the first step of the environment's schema (env.ts):
 * @nestjs/config reads variables and .env files only, and the secrets must
 * be in place before ConfigModule validates them and before any module (or
 * code that reads process.env itself) uses them. A KMS source would be
 * another step here.
 */

/** The variables that hold secrets: filled by `secret()`, read by `secretNames()`. */
export const secretRegistry = z.registry<undefined>();

/** The names of a schema's secret variables (declared with `secret()`), in declaration order. */
export const secretNames = (schema: z.ZodObject) =>
  Object.entries(schema.shape)
    .filter(([, variable]) => secretRegistry.has(variable as z.ZodType))
    .map(([name]) => name);

/** What went wrong with one variable. Never its value: these are logged. */
export interface SecretFileProblem {
  variable: string;
  message: string;
}

/** Reads a secret's file; tests pass their own. */
export type ReadSecretFile = (path: string) => string;

const readSecretFile: ReadSecretFile = (path) =>
  readFileSync(appPath(path), 'utf8');

/**
 * `contents` without its line breaks at the end (`echo`, editors, Windows'
 * CRLF): they aren't part of the value. Each is `\n` or `\r\n`; a lone `\r`
 * stays. A loop, not `/(?:\r?\n)+$/`: that regex is quadratic on a file of
 * many line breaks followed by anything else (SonarCloud S8786).
 */
function withoutTrailingLineBreaks(contents: string) {
  let end = contents.length;
  while (contents.charAt(end - 1) === '\n') {
    end -= contents.charAt(end - 2) === '\r' ? 2 : 1;
  }
  return contents.slice(0, end);
}

const isSet = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * The values of the secrets whose `X_FILE` is set, read from their files;
 * `env` itself is left alone. An empty variable counts as unset, as
 * everywhere in the environment (`FOO=` in a .env file). A file that is
 * missing, unreadable or empty is a problem, not an unset secret: it names a
 * value that didn't arrive. A relative path resolves against the app's
 * directory (`apps/api`, `/app` in the image).
 */
export function readSecretFiles(
  env: Readonly<Record<string, unknown>>,
  names: readonly string[],
  read: ReadSecretFile = readSecretFile,
) {
  const values: Record<string, string> = {};
  const problems: SecretFileProblem[] = [];
  for (const name of names) {
    const variable = `${name}_FILE`;
    const path = env[variable];
    if (!isSet(path)) {
      continue;
    }
    if (isSet(env[name])) {
      problems.push({
        variable,
        message: `${name} and ${variable} are both set: keep one`,
      });
      continue;
    }
    let contents: string;
    try {
      contents = read(path.trim());
    } catch (error) {
      // The code (ENOENT, EACCES, EISDIR), not the message: nothing of the file gets out.
      const code = (error as NodeJS.ErrnoException).code ?? 'unreadable';
      problems.push({
        variable,
        message: `can't read ${path.trim()} (${code})`,
      });
      continue;
    }
    const value = withoutTrailingLineBreaks(contents);
    if (value.trim() === '') {
      problems.push({ variable, message: `${path.trim()} is empty` });
      continue;
    }
    values[name] = value;
  }
  return { values, problems };
}

/**
 * Other programs' variables that end in `_FILE`: never warned about.
 * (AWS SDK and OpenSSL settings.)
 */
const FOREIGN_FILE_VARIABLES = new Set([
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'SSL_CERT_FILE',
]);

/**
 * The `*_FILE` variables that read nothing: their name isn't a secret's
 * plus `_FILE` (a typo, `JWT_SECERT_FILE`, or a variable that isn't a
 * secret, `PORT_FILE`). Names only.
 */
export function unusedFileVariables(
  env: Readonly<Record<string, unknown>>,
  names: readonly string[],
) {
  const secrets = new Set(names);
  return Object.keys(env).filter(
    (key) =>
      /^[A-Z][A-Z0-9_]*_FILE$/.test(key) &&
      isSet(env[key]) &&
      !secrets.has(key.slice(0, -'_FILE'.length)) &&
      !FOREIGN_FILE_VARIABLES.has(key),
  );
}

/**
 * One secret outside the schema (`node dist/migrate`): its file's value,
 * else the variable's, and what went wrong.
 */
export function secretValue(
  env: Readonly<Record<string, unknown>>,
  name: string,
  read: ReadSecretFile = readSecretFile,
) {
  const { values, problems } = readSecretFiles(env, [name], read);
  const fallback = env[name];
  return {
    value: values[name] ?? (isSet(fallback) ? fallback.trim() : undefined),
    problems,
  };
}

/** How the step reports a `*_FILE` variable that reads nothing (never a value). */
export type WarnUnusedFile = (message: string) => void;

const warnUnusedFile: WarnUnusedFile = (message) =>
  Logger.warn(message, 'Config');

/**
 * `schema` with its secrets' files read first: each `X_FILE` becomes `X`.
 * Every problem is an issue on `X_FILE`, reported together with the
 * schema's own issues, so ConfigModule stops the app listing them all. A
 * `*_FILE` variable that reads nothing is warned about by name.
 *
 * The values also go into process.env, where ConfigModule never overwrites
 * a variable already present (Compose passes `X=` empty): the code that
 * reads process.env itself (`loadOrCreateSecret`, NestJS Observe's switch,
 * the webhooks module's keys) sees what ConfigService does. X_FILE stays
 * there too (ConfigModule copies it back anyway), so a second validation in
 * the same process reads the file again instead of finding both set.
 */
export function withSecretFiles<Schema extends z.ZodObject>(
  schema: Schema,
  {
    read = readSecretFile,
    processEnv = process.env,
    warn = warnUnusedFile,
  }: {
    read?: ReadSecretFile;
    processEnv?: NodeJS.ProcessEnv;
    warn?: WarnUnusedFile;
  } = {},
) {
  const names = secretNames(schema);
  /** What this step put into process.env, by variable. */
  const fromFiles = new Map<string, string>();
  const warned = new Set<string>();
  return z.preprocess((input, ctx) => {
    if (typeof input !== 'object' || input === null) {
      return input;
    }
    const env = { ...(input as Record<string, unknown>) };
    for (const [name, value] of fromFiles) {
      if (env[name] === value) {
        delete env[name];
      }
    }
    for (const variable of unusedFileVariables(env, names)) {
      if (!warned.has(variable)) {
        warned.add(variable);
        warn(
          `${variable} is set, but ${variable.slice(0, -'_FILE'.length)} is not a secret read from a file: ignored (a typo?)`,
        );
      }
    }
    const { values, problems } = readSecretFiles(env, names, read);
    for (const [name, value] of Object.entries(values)) {
      processEnv[name] = value;
      fromFiles.set(name, value);
    }
    // The schema drops the X_FILE variables: it doesn't declare them.
    const resolved = { ...env, ...values };
    if (problems.length > 0) {
      for (const { variable, message } of problems) {
        ctx.addIssue({ code: 'custom', path: [variable], message });
      }
      // An issue here stops the pipe before the schema: its issues now, so
      // one start reports everything.
      for (const issue of schema.safeParse(resolved).error?.issues ?? []) {
        ctx.addIssue(issue as Parameters<typeof ctx.addIssue>[0]);
      }
    }
    return resolved;
  }, schema);
}
