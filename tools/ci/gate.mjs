import { pathToFileURL } from 'node:url';

export function gate(expected, needs) {
  if (
    !Array.isArray(expected) ||
    !expected.includes('changes') ||
    new Set(expected).size !== expected.length
  )
    throw new Error('Invalid expected job list');
  for (const job of expected) {
    if (needs[job]?.result !== 'success')
      throw new Error(
        `${job}: expected success, got ${needs[job]?.result ?? 'missing'}`,
      );
  }
  for (const [job, { result }] of Object.entries(needs)) {
    if (!['success', 'skipped'].includes(result))
      throw new Error(`${job}: ${result}`);
    if (!expected.includes(job) && result !== 'skipped')
      throw new Error(`${job}: unexpected result ${result}`);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  gate(JSON.parse(process.env.EXPECTED), JSON.parse(process.env.NEEDS));
  console.log('All expected CI checks passed.');
}
