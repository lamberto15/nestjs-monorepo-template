// Lists every accessibility finding the run attached (test/fixtures.ts) as
// Markdown for the job summary: node scripts/axe-summary.mjs >> $GITHUB_STEP_SUMMARY
// Serious and critical ones fail their tests; the others are only listed here.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = JSON.parse(
  readFileSync(resolve(root, 'test-results/report.json'), 'utf8'),
);

const findings = new Map();
function visit(suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests) {
      // The last attempt of a test only: a retry repeats the scan.
      const result = test.results.at(-1);
      for (const attachment of result?.attachments ?? []) {
        if (!attachment.name.startsWith('axe-') || !attachment.body) continue;
        const body = Buffer.from(attachment.body, 'base64').toString('utf8');
        for (const finding of JSON.parse(body)) {
          findings.set(`${finding.page}|${finding.id}`, finding);
        }
      }
    }
  }
  for (const child of suite.suites ?? []) visit(child);
}
for (const suite of report.suites) visit(suite);

console.log('## Accessibility (axe)\n');
if (findings.size === 0) {
  console.log('No violations on the pages scanned.');
} else {
  console.log(
    'Serious and critical violations fail the job; the rest are listed.\n',
  );
  console.log('| Page | Impact | Rule | Elements |');
  console.log('| --- | --- | --- | --- |');
  for (const f of [...findings.values()].sort((a, b) =>
    a.page.localeCompare(b.page),
  )) {
    const nodes = f.nodes
      .map((node) => `\`${node.replaceAll('|', '\\|')}\``)
      .join('<br>');
    console.log(
      `| ${f.page} | ${f.impact} | [${f.id}](${f.helpUrl}): ${f.help} | ${nodes} |`,
    );
  }
}
