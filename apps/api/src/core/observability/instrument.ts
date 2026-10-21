import { startSentry } from './sentry.js';
import { startOpenTelemetry } from './telemetry.js';

/**
 * Starts the tracing and error-tracking SDKs. `main.ts` awaits this import
 * (after the development settings) before it loads the app: the SDKs patch the
 * libraries the app loads next, so they cannot start later. Before the
 * environment is validated, so the `_FILE` secrets are read here (telemetry.ts,
 * sentry.ts). A no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` or `SENTRY_DSN`
 * (or its file) is set.
 */
await startOpenTelemetry();
await startSentry();
