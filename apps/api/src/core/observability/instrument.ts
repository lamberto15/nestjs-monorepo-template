import { startSentry } from './sentry.js';
import { startOpenTelemetry } from './telemetry.js';

/**
 * Starts the tracing and error-tracking SDKs. The first import of
 * `main.ts` (after the development settings): they patch the libraries the
 * app loads next, so they cannot start later. A no-op unless
 * `OTEL_EXPORTER_OTLP_ENDPOINT` or `SENTRY_DSN` is set.
 */
await startOpenTelemetry();
await startSentry();
