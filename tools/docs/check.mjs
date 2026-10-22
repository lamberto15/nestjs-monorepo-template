#!/usr/bin/env node
// Lightweight drift checks, not proof of correct runtime behavior.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownLinks } from './links.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const docs = join(root, 'docs');
const errors = [];
const full = (p) => join(root, p);
function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(p));
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}
const files = [full('README.md'), ...markdownFiles(docs)];
for (const from of files) {
  let fence = '';
  for (const [index, line] of readFileSync(from, 'utf8').split('\n').entries()) {
    const marker = /^\s*(\u0060{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (fence === marker[1][0]) fence = '';
      continue;
    }
    if (fence) continue;
    for (const href of markdownLinks(line)) {
      if (/^(?:#|[a-z][\w+.-]*:|\/\/)/i.test(href)) continue;
      const targetName = href.split(/[?#]/)[0];
      if (!targetName) continue;
      const target = resolve(dirname(from), decodeURIComponent(targetName));
      if (relative(root, target).startsWith('..' + sep)) {
        errors.push(relative(root, from) + ':' + (index + 1) + ' link escapes checkout: ' + href);
      } else if (!existsSync(target) && !existsSync(target + '.md') && !existsSync(join(target, 'index.md'))) {
        errors.push(relative(root, from) + ':' + (index + 1) + ' missing file: ' + href);
      }
    }
  }
}
// Intentional narrow checks: when these defaults or source names change,
// documentation reviewers must reassess the corresponding claims.
const contracts = [
  ['workspace', 'pnpm-workspace.yaml', /apps\/\*/],
  ['Node 24', 'package.json', /"version": "\^24\.0\.0"/],
  ['Nest API', 'apps/api/package.json', /"@nestjs\/common"/],
  ['React web', 'apps/web/package.json', /"react":/],
  ['typed client', 'packages/api-client/package.json', /"@nestjs-monorepo-template\/api-client"/],
  ['worker role', 'apps/api/src/worker.ts', /APP_ROLE\s*=\s*'worker'/],
  ['example notes registration', 'apps/api/src/features/index.ts', /NOTES_FEATURE/],
  ['feature generator', 'tools/feature/add.mjs', /export async function addFeature/],
  ['tenant modes', 'apps/api/src/iam/iam.env.ts', /TENANCY:\s*z\.enum\(\['multi', 'single'\]\)/],
  ['idempotency modes', 'apps/api/src/platform/platform.env.ts', /IDEMPOTENCY:\s*choice\(\['required', 'optional'\], 'required'\)/],
  ...['WEBHOOKS', 'REPORTS', 'USAGE', 'REALTIME'].map((name) =>
    [name + ' default', 'apps/api/src/platform/platform.env.ts', new RegExp(name + ": flag\\('on'\\)")]),
  ['wizard module defaults', 'tools/setup/plan.mjs', /fresh:\s*\(\)\s*=>\s*true/],
  ['noncommercial license', 'LICENSE', /PolyForm Noncommercial License 1\.0\.0/],
  ['dev PDF service', 'compose.dev.yaml', /gotenberg:/],
  ['load-test report only', '.github/workflows/load-test.yml', /--report-only/],
];
for (const [name, path, expected] of contracts) {
  if (!existsSync(full(path)) || !expected.test(readFileSync(full(path), 'utf8'))) {
    errors.push('Source contract changed: ' + name + ' (' + path + '). Reverify docs.');
  }
}
if (errors.length) {
  errors.forEach((x) => process.stderr.write('docs: ' + x + '\n'));
  process.exitCode = 1;
} else {
  process.stdout.write('docs: checked ' + files.length + ' Markdown files and ' + contracts.length + ' source contracts\n');
}
