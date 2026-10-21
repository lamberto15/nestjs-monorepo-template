/**
 * The operator CLI (docs/deployment.md, "Operator CLI"): break-glass
 * commands over the app's own services, run on a server by someone who holds
 * its environment: a one-time password, removing two-factor, unlocking an
 * account, deleting a setting, creating an administrator. Every change is
 * audited as `system:ops` with the operator's OS user and host.
 *
 *   pnpm ops <command>                                  (development)
 *   docker compose run --rm api node dist/cli <command> (a deployment)
 *
 * The app boots as APP_ROLE=api, as seed-demo.ts does: no queue workers,
 * outbox relay, workflow worker or cron jobs in this short process, and no
 * HTTP listener (a command is never a route). What a command starts (a
 * security notification, an email) waits in PostgreSQL for the app's own
 * workers.
 */
process.env.APP_ROLE = 'api';
await import('./cli/run.js');
