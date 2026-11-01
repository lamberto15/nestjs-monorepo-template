import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// compose.prod.yaml has no env_file: a variable it doesn't list never reaches
// the containers, so one env.example offers would silently do nothing.
const read = (path) => readFileSync(path, 'utf8');
const compose = read('compose.prod.yaml');
const example = read('env.example');
const schemas = execFileSync('git', ['ls-files', 'apps/api/src/*.env.ts'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .map(read)
  .join('\n');

const declared = new Set(
  [...schemas.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]),
);
const offered = [...example.matchAll(/^(?:# )?([A-Z][A-Z0-9_]+)=/gm)].map(
  (match) => match[1],
);
// Never for a deployment: compose.loadtest.yaml sets the first, and
// development and tests the second.
const notForADeployment = new Set([
  'RATE_LIMIT_MULTIPLIER',
  'SSO_ALLOW_LOOPBACK',
]);
// Compose builds REDIS_URL from the password, so the app needs only the URL.
const builtByCompose = new Set(['REDIS_PASSWORD']);
// migrate's alone: api and worker must never hold the owner's URL.
const migrateOnly = new Set(['DATABASE_OWNER_URL_FILE']);

test('compose.prod.yaml passes every app variable env.example offers', () => {
  const missing = offered.filter(
    (name) =>
      declared.has(name) &&
      !notForADeployment.has(name) &&
      !builtByCompose.has(name) &&
      !new RegExp(`^ +${name}:`, 'm').test(compose),
  );
  assert.deepEqual(missing, []);
});

test("each app secret's file reaches api and worker", () => {
  const missing = offered.filter((name) => {
    const secret = name.replace(/_FILE$/, '');
    if (secret === name || !declared.has(secret) || migrateOnly.has(name)) {
      return false;
    }
    const mount = secret.toLowerCase();
    return (
      !compose.includes(`${name}: \${${name}:+/run/secrets/${mount}}`) ||
      compose.split(`- ${mount}\n`).length < 3 ||
      !compose.includes(`file: \${${name}:-./secret.empty}`)
    );
  });
  assert.deepEqual(missing, []);
});
