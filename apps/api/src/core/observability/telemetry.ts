import { secretValue } from '../config/secret-files.js';
import { logRedaction, type LogRedaction } from '../logging/redaction.js';
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
 * Started by `instrument.ts`, which `main.ts` awaits before it loads the app:
 * OpenTelemetry patches `http`, Express and `pg` as they load, so it must run
 * before them. The SDK packages are imported only when configured, so an
 * unconfigured app pays nothing.
 */
export const otelEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim());

export const sentryEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  Boolean(env.SENTRY_DSN?.trim());

/**
 * What the exporters hand back for a 429, 502, 503 or 504 once their retries
 * are spent or `Retry-After` outlasts the timeout (otlp-export-delegate.js):
 * those statuses are "retryable", and the result keeps no status or code.
 */
const RETRYABLE_FAILURE = 'Export failed with retryable status';

/**
 * The HTTP status an OTLP exporter's failure stands for: a 401 or 403 is
 * `OTLPExporterError.code`; a 429 has none (see `RETRYABLE_FAILURE`), so the
 * retryable failure counts as the 429 it nearly always is, a rate limit or an
 * exhausted plan (a collector that stays unavailable, 502/503/504, is a dead
 * pipeline too and is counted with it).
 */
export const exportFailureStatus = (error: unknown): number | undefined => {
  const { code, message } = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
  };
  if (typeof code === 'number') {
    return code;
  }
  return message === RETRYABLE_FAILURE ? 429 : undefined;
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

/**
 * What the HTTP instrumentation masks in a query string when it is given no
 * list (its README). A list replaces them, so ours starts from them.
 */
const INSTRUMENTATION_QUERY_DEFAULTS = [
  'sig',
  'Signature',
  'AWSAccessKeyId',
  'X-Goog-Signature',
  'X-Amz-Signature',
  'X-Amz-Credential',
  'X-Amz-Security-Token',
];

/**
 * The query parameters whose values a span must not carry: the log-redaction
 * registry's names (`query.code` is `code`; the OIDC callbacks carry `code` and
 * `state`), on top of the instrumentation's own. Spans carry `url.query`
 * (incoming) and `url.full` (outgoing), which the request logger leaves out.
 * Read when the SDK starts, so a name declared later (redaction.ts) is not in
 * it. Names are matched as written.
 */
export function redactedQueryParams(redaction: LogRedaction = logRedaction) {
  const names = redaction
    .paths()
    .map((path) => (path.startsWith('query.') ? path.slice(6) : path))
    .filter((name) => !name.includes('.'));
  return [...new Set([...INSTRUMENTATION_QUERY_DEFAULTS, ...names])];
}

/**
 * Runs `build` (which makes the OTLP exporters) with the collector's
 * credential in place. It may be a secret in a file
 * (`OTEL_EXPORTER_OTLP_HEADERS_FILE`), and this runs before the environment
 * is validated, which is what reads those: so it is read here. The exporters
 * take `OTEL_EXPORTER_OTLP_HEADERS` from the environment when they are built,
 * so it is set for that moment only: the validation refuses the variable set
 * beside its file.
 */
function withOtlpHeaders<T>(env: NodeJS.ProcessEnv, build: () => T): T {
  const { value: headers } = secretValue(env, 'OTEL_EXPORTER_OTLP_HEADERS');
  const before = env.OTEL_EXPORTER_OTLP_HEADERS;
  if (headers) {
    env.OTEL_EXPORTER_OTLP_HEADERS = headers;
  }
  try {
    return build();
  } finally {
    if (before === undefined) {
      delete env.OTEL_EXPORTER_OTLP_HEADERS;
    } else {
      env.OTEL_EXPORTER_OTLP_HEADERS = before;
    }
  }
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
  const [traceExporter, metricExporter] = withOtlpHeaders(env, () => [
    new OTLPTraceExporter(),
    new OTLPMetricExporter(),
  ]);
  const redactedParams = redactedQueryParams();
  const sdk = new NodeSDK({
    traceExporter: countRefusals(traceExporter),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: countRefusals(metricExporter),
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
          // Secrets in a query string (the OIDC callback's code and state)
          // stay out of the spans, as they stay out of the logs.
          redactedQueryParamsServer: redactedParams,
          redactedQueryParams: redactedParams,
        },
      }),
    ],
  });
  sdk.start();
  // Flush what is buffered when the process is asked to stop.
  process.once('SIGTERM', () => void sdk.shutdown().catch(() => undefined));
  return sdk;
}
