import {
  observeRefusalStatus,
  onTelemetryRejected,
  recordTelemetryFailure,
  resetTelemetryHealth,
} from './telemetry-health.js';

describe('telemetry health', () => {
  afterEach(resetTelemetryHealth);

  it('counts the refusals that mean a dead pipeline, nothing else', () => {
    const heard: string[] = [];
    onTelemetryRejected((target, status) => heard.push(`${target}:${status}`));
    for (const status of [401, 403, 429, 500, 503, 400, undefined]) {
      recordTelemetryFailure('otlp', status);
    }
    expect(heard).toEqual(['otlp:401', 'otlp:403', 'otlp:429']);
  });

  it('tells a late listener what already happened', () => {
    recordTelemetryFailure('observe', 429);
    recordTelemetryFailure('observe', 429);
    const heard: string[] = [];
    onTelemetryRejected((target, status) => heard.push(`${target}:${status}`));
    expect(heard).toEqual(['observe:429', 'observe:429']);
  });

  it('stops telling a listener that unsubscribed', () => {
    const heard: number[] = [];
    const stop = onTelemetryRejected((_target, status) => heard.push(status));
    stop();
    recordTelemetryFailure('sentry', 429);
    expect(heard).toEqual([]);
  });

  it("reads the status out of Observe's refusal messages", () => {
    expect(
      observeRefusalStatus(
        'Error: Telemetry rate-limited (429) - monthly quota reached.',
      ),
    ).toBe(429);
    expect(
      observeRefusalStatus('Error: Telemetry rejected (401). Check appKey.'),
    ).toBe(401);
    expect(observeRefusalStatus('GET /v1/things 429')).toBeUndefined();
    expect(observeRefusalStatus(new Error('boom'))).toBeUndefined();
  });
});
