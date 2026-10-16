// Generates src/schema.ts from openapi.json (openapi-typescript).
//
//   node scripts/generate.mjs            openapi.json → src/schema.ts
//   node scripts/generate.mjs --check    dumps the API's document afresh
//                                        (apps/api's dist/ must be built), generates
//                                        from it in memory and fails when
//                                        openapi.json or src/schema.ts differ
//
// One change on the way: `Idempotency-Key` is optional in the types, because
// createApiClient() sends a fresh key on every POST that doesn't set one.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(packageDir, '../../apps/api');
const specFile = join(packageDir, 'openapi.json');
const schemaFile = join(packageDir, 'src/schema.ts');

const HEADER = `/**
 * Generated from openapi.json by \`pnpm client:generate\`: do not edit.
 * \`pnpm client:check\` fails when it is stale.
 */

`;

async function generate(specText) {
  const spec = JSON.parse(specText);
  for (const operations of Object.values(spec.paths ?? {})) {
    for (const operation of Object.values(operations)) {
      for (const parameter of operation?.parameters ?? []) {
        if (
          parameter.in === 'header' &&
          parameter.name.toLowerCase() === 'idempotency-key'
        ) {
          parameter.required = false;
        }
      }
    }
  }
  return HEADER + astToString(await openapiTS(spec));
}

if (process.argv.includes('--check')) {
  const dir = mkdtempSync(join(tmpdir(), 'api-client-'));
  try {
    const freshSpecFile = join(dir, 'openapi.json');
    execFileSync(
      process.execPath,
      [join(apiDir, 'dist/openapi-dump.js'), freshSpecFile],
      { cwd: apiDir, stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const freshSpec = readFileSync(freshSpecFile, 'utf8');
    const stale = [];
    if (freshSpec !== readFileSync(specFile, 'utf8')) {
      stale.push('openapi.json');
    }
    if ((await generate(freshSpec)) !== readFileSync(schemaFile, 'utf8')) {
      stale.push('src/schema.ts');
    }
    if (stale.length > 0) {
      console.error(
        `packages/api-client: ${stale.join(' and ')} ${stale.length > 1 ? 'are' : 'is'} stale (the API changed). Run pnpm client:generate and commit the result.`,
      );
      process.exit(1);
    }
    console.log(
      'packages/api-client: openapi.json and src/schema.ts are up to date.',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  writeFileSync(schemaFile, await generate(readFileSync(specFile, 'utf8')));
  console.log(`Generated ${schemaFile}`);
}
