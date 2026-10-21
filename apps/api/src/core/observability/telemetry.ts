import { recordTelemetryFailure } from './telemetry-health.js';

/**
 * OpenTelemetry export and Sentry error tracking, both off until configured
 * and both independent of NestJS Observe (`observe.ts`): a project picks
 * one, or runs them side by side.
 *
 * - **OpenTelemetry** (`OTEL_EXPORTER_OTLP_ENDPOINT`): traces and metrics
 *   through `@opentelemetry/sdk-node`, exported over OTLP/HTTP to any
 *   collector (Grafana Tempo, Jaeger, Honeycomb, Datadog). The SDK reads
 *   the standard variables itself (`OTEL_EXPORTER_OTLP_HEADERS`,
 *   `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER`, …).
 * - **Sentry** (`SENTRY_DSN`): unhandled errors, through `@sentry/nestjs`,
 *   scrubbed by the log-redaction registry before they leave the process.
 *
 * Started by `instrument.ts`, the first import of `main.ts`: OpenTelemetry
 * patches `http`, Express, `pg` and `ioredis` as they load, so it must run
 * before them. The SDK packages are imported only when configured, so an
 * unconfigured app pays nothing.
 */
export const otelEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim());

export const sentryEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  Boolean(env.SENTRY_DSN?.trim());

/** The HTTP status an OTLP exporter's failure carries (`OTLPExporterError.code`). */
export const exportFailureStatus = (error: unknown): number | undefined => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'number' ? code : undefined;
};

/** `ExportResultCode.SUCCESS`; the SDK's enum, spelled out so this module imports nothing from it. */
const EXPORT_SUCCESS = 0;

/**
 * Wraps an exporter's `export()` so a collector that turns the data away
 * (401, 403, 429) is counted (telemetry-health.ts) instead of vanishing in
 * the SDK's diagnostic log. Custom code: the OTLP exporters have no
 * metric of their own for refused exports.
 */
export function countRefusals<
  Items,
  Result extends { code: number; error?: unknown },
  Exporter extends {
    export(items: Items, done: (result: Result) => void): void;
  },
>(
  exporter: Exporter,
  record: typeof recordTelemetryFailure = recordTelemetryFailure,
) {
  const original = exporter.export.bind(exporter);
  exporter.export = (items, done) =>
    original(items, (result) => {
      if (result.code !== EXPORT_SUCCESS) {
        record('otlp', exportFailureStatus(result.error));
      }
      done(result);
    });
  return exporter;
}

/** Starts OpenTelemetry when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. */
export async function startOpenTelemetry(env: NodeJS.ProcessEnv = process.env) {
  if (!otelEnabled(env)) {
    return undefined;
  }
  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { PeriodicExportingMetricReader },
    { getNodeAutoInstrumentations },
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/auto-instrumentations-node'),
  ]);
  // The service's name and version as resource attributes, through the
  // SDK's own variables (an explicit OTEL_* setting wins).
  env.OTEL_SERVICE_NAME ||= env.SERVICE_NAME || 'api';
  if (env.GIT_SHA && !env.OTEL_RESOURCE_ATTRIBUTES) {
    env.OTEL_RESOURCE_ATTRIBUTES = `service.version=${env.GIT_SHA}`;
  }
  const sdk = new NodeSDK({
    traceExporter: countRefusals(new OTLPTraceExporter()),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: countRefusals(new OTLPMetricExporter()),
      }),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        // One span per file read and per DNS or socket call drowns the trace.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        // Health probes every few seconds are no trace worth keeping.
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (request) =>
            request.url?.startsWith('/health') ?? false,
        },
      }),
    ],
  });
  sdk.start();
  // Flush what is buffered when the process is asked to stop.
  process.once('SIGTERM', () => void sdk.shutdown().catch(() => undefined));
  return sdk;
}
