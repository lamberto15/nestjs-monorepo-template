import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function publicationGate(flags, needs, plan = {}) {
  if (plan.error) throw new Error(plan.error);
  for (const [job, flag] of [
    ['publish', 'api_image'],
    ['publish-caddy', 'caddy'],
    ['publish-gotenberg', 'gotenberg'],
  ]) {
    const expected = flags[flag] === 'true' ? 'success' : 'skipped';
    if (needs[job]?.result !== expected)
      throw new Error(`${job}: expected ${expected}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  publicationGate(
    JSON.parse(process.env.FLAGS),
    JSON.parse(process.env.NEEDS),
    process.env.PLAN_FILE
      ? JSON.parse(readFileSync(process.env.PLAN_FILE, 'utf8'))
      : {},
  );
