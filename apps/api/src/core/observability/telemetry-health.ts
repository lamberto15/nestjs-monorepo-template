/**
 * Whether the telemetry pipelines still get through. A hosted collector that
 * refuses what it is sent (401/403: a revoked key, 429: out of credits, as
 * NestJS Observe did, issue #404) leaves the app running and blind, with the
 * only trace of it in a log line. Every refusal is counted here and served
 * on /metrics as `telemetry_rejected_total{target,status}`
 * (`MetricsService`), which the TelemetryRejected alert reads
 * (monitoring/prometheus/alerts.yml).
 *
 * A module of its own, not part of `MetricsService`: the exporters start in
 * `instrument.ts`, before Nest builds anything, and report from there.
 */
export type TelemetryTarget = 'observe' | 'otlp' | 'sentry';

type Listener = (target: TelemetryTarget, status: number) => void;

/** The statuses that mean "the collector turned us away", not a passing fault. */
const REFUSALS = new Set([401, 403, 429]);

const counts = new Map<string, number>();
const listeners = new Set<Listener>();

const keyOf = (target: TelemetryTarget, status: number) =>
  `${target}:${status}`;

/** Counts a refusal; other statuses (timeouts, 5xx) are not a dead pipeline and are left to the exporter's retries. */
export function recordTelemetryFailure(
  target: TelemetryTarget,
  status: number | undefined,
) {
  if (status === undefined || !REFUSALS.has(status)) {
    return;
  }
  counts.set(
    keyOf(target, status),
    (counts.get(keyOf(target, status)) ?? 0) + 1,
  );
  for (const listener of listeners) {
    listener(target, status);
  }
}

/**
 * Hears every refusal, those before it subscribed included (the exporters
 * start before the metrics service exists). Returns the unsubscribe.
 */
export function onTelemetryRejected(listener: Listener) {
  for (const [key, count] of counts) {
    const [target, status] = key.split(':');
    for (let i = 0; i < count; i++) {
      listener(target as TelemetryTarget, Number(status));
    }
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The refusal a log line reports. NestJS Observe's agent runs in a worker
 * thread and says what it was told by the ingest endpoint only as a message
 * ("Telemetry rate-limited (429) - …", "Telemetry rejected (401) - …"); this
 * reads the status out of it. Custom code, because @nestjs/observe has no
 * hook or metric for a refused upload.
 */
const OBSERVE_REFUSAL = /\b(?:telemetry|profile upload)\b[^()\n]*\((\d{3})\)/i;

export function observeRefusalStatus(message: unknown): number | undefined {
  if (typeof message !== 'string') {
    return undefined;
  }
  const status = OBSERVE_REFUSAL.exec(message)?.[1];
  return status ? Number(status) : undefined;
}

/** Forgets everything: tests only. */
export function resetTelemetryHealth() {
  counts.clear();
  listeners.clear();
}
