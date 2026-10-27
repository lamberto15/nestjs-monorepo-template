// Part of `pnpm size` (docs/monorepo.md, "Languages"): only `en` may be in the
// first page load. The size budgets cannot see this: a language bundled into
// the entry's graph would still be a file named locale-*.js. Reads the built
// dist/index.html, whose script and modulepreload links are the entry and
// everything it imports statically.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(
  fileURLToPath(new URL('../dist/index.html', import.meta.url)),
  'utf8',
);
const initial = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map(
  (match) => match[1],
);
const locales = initial.filter((file) => /\/locale-/.test(file));

if (initial.length === 0) {
  console.error('check-lazy-locales: no scripts found in dist/index.html');
  process.exit(1);
}
if (locales.length > 0) {
  console.error(
    `A language besides en is in the first page load (src/i18n.ts loads them on demand):\n  ${locales.join('\n  ')}`,
  );
  process.exit(1);
}
console.log(
  `No language besides en among the ${initial.length} scripts of the first page load.`,
);
