/**
 * The worker process: the same app with APP_ROLE=worker. It runs the
 * background work (queue jobs, the outbox relay, webhook deliveries,
 * workflow steps, cron jobs) and answers only its health checks, on a port
 * nothing routes to. API instances (APP_ROLE=api) run none of it, so a heavy
 * export never slows a request down, and each side scales on its own.
 *
 *   node dist/worker
 */
process.env.APP_ROLE = 'worker';
await import('./main.js');
