import { LogRedaction, REDACTED } from '../logging/redaction.js';
import { scrub, tracesSampleRate } from './sentry.js';

describe('Sentry scrubbing', () => {
  const redaction = new LogRedaction();

  it('masks the registry’s headers and fields in an event', () => {
    const event = scrub(
      {
        message: 'Sign-in failed for Bearer abc.def.ghi-1234567890',
        request: {
          url: 'https://api.example.com/v1/auth/sign-in',
          headers: {
            authorization: 'Bearer secret-token-value',
            accept: '*/*',
          },
          cookies: { sid: 'abc' },
          data: { email: 'a@example.com', password: 'hunter2' },
        },
        extra: { refreshToken: 'r-123456' },
      },
      redaction,
    );
    const text = JSON.stringify(event);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('secret-token-value');
    expect(text).not.toContain('r-123456');
    expect(event.request.headers.authorization).toBe(REDACTED);
    expect(event.request.data.password).toBe(REDACTED);
    expect(event.request.headers.accept).toBe('*/*');
    expect(event.request.data.email).toBe('a@example.com');
  });

  it('keeps long stack traces whole', () => {
    const frames = Array.from({ length: 50 }, (_, i) => ({
      filename: `file${i}.js`,
      lineno: i,
    }));
    const event = scrub(
      { exception: { values: [{ stacktrace: { frames } }] } },
      redaction,
    );
    expect(event.exception.values[0].stacktrace.frames).toHaveLength(50);
  });

  it('reads the trace sample rate, 0 to 1', () => {
    expect(tracesSampleRate({})).toBeUndefined();
    expect(tracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: '0.25' })).toBe(0.25);
    expect(tracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: '0' })).toBe(0);
    expect(
      tracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: '2' }),
    ).toBeUndefined();
    expect(
      tracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: 'x' }),
    ).toBeUndefined();
  });
});
