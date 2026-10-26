import { performance } from 'node:perf_hooks';

// Private INTERACTIVE_REQUESTS_JSON input: { baseUrl, headers, requests: [{ name, path }] }.
// Supply it through the environment; headers may contain a session cookie or token.
// Run the same input before and after deployment. Output contains no URLs,
// headers, response bodies, or tenant identifiers.
const config = JSON.parse(process.env.INTERACTIVE_REQUESTS_JSON ?? '{}');
const base = new URL(config.baseUrl);
if (!['http:', 'https:'].includes(base.protocol)) throw new Error('HTTP URL required');
if (!config.requests?.length) throw new Error('At least one request required');
const results = [];
for (const request of config.requests) {
  const url = new URL(request.path, base);
  if (url.origin !== base.origin) throw new Error('Requests must use the configured origin');
  for (const concurrency of [1, 3]) {
    const durations = [];
    let next = 0;
    let failures = 0;
    let timeouts = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next++ < 100) {
        const start = performance.now();
        try {
          const response = await fetch(url, {
            headers: config.headers,
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          });
          await response.arrayBuffer();
          if (!response.ok) failures++;
        } catch (error) {
          failures++;
          if (error.name === 'TimeoutError') timeouts++;
        }
        durations.push(performance.now() - start);
      }
    }));
    durations.sort((a, b) => a - b);
    const p95Ms = durations[Math.ceil(durations.length * 0.95) - 1];
    results.push({ name: request.name, concurrency, requests: durations.length,
      p95Ms: Math.round(p95Ms), failures, timeouts,
      passed: p95Ms < 2_000 && failures === 0 });
    console.log(JSON.stringify(results.at(-1)));
  }
}
if (results.some((result) => !result.passed)) process.exitCode = 1;
