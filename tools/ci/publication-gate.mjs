import { pathToFileURL } from 'node:url';

export function publicationGate(flags, needs) {
  for (const [job, flag] of [
    ['publish', 'image'],
    ['publish-caddy', 'caddy'],
    ['publish-gotenberg', 'gotenberg'],
  ]) {
    const expected = flags[flag] === 'true' ? 'success' : 'skipped';
    if (needs[job]?.result !== expected)
      throw new Error(`${job}: expected ${expected}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  publicationGate(JSON.parse(process.env.FLAGS), JSON.parse(process.env.NEEDS));
