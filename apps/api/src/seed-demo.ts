/**
 * The demo seed (docs/development.md, "Demo data"): demo users with roles,
 * teams, tags and notes with comments and a file, written through the
 * services as the system principal `system:demo-seed`, on a development
 * database only. The users' passwords are printed once.
 *
 *   pnpm db:seed:demo
 *
 * The app boots as APP_ROLE=api, as worker.ts sets its role: no queue
 * workers, outbox relay, workflow worker or cron jobs in this short
 * process. What the seed starts (the notes' publication, their webhooks)
 * waits in PostgreSQL for the app's own workers.
 */
process.env.APP_ROLE = 'api';
await import('./demo/run-demo-seed.js');
