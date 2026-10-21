import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Sentry from '@sentry/nestjs';
import { LogRedaction, REDACTED } from '../logging/redaction.js';
import {
  scrub,
  sentryIntegrations,
  startSentry,
  tracesSampleRate,
} from './sentry.js';

// The SDK itself, but for init(): starting it in a test would install its
// handlers in the test process.
vi.mock('@sentry/nestjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/nestjs')>()),
  init: vi.fn(),
}));

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

describe('starting Sentry', () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'sentry-spec-'));
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  afterEach(() => vi.mocked(Sentry.init).mockClear());

  it('stays off without a DSN', async () => {
    expect(await startSentry({})).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('reads the DSN from its file: it starts before the environment is validated', async () => {
    const file = join(directory, 'sentry-dsn');
    writeFileSync(file, 'https://key@o1.ingest.sentry.io/1\n');
    expect(await startSentry({ SENTRY_DSN_FILE: file })).toBe(true);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://key@o1.ingest.sentry.io/1',
        integrations: sentryIntegrations,
      }),
    );
  });

  it('leaves Node to end the process on a floating rejection', () => {
    const names = (integrations: { name: string }[]) =>
      integrations.map((integration) => integration.name);
    const defaults = Sentry.getDefaultIntegrations({});
    // The default integration that turns the crash into a log line ...
    expect(names(defaults)).toContain('OnUnhandledRejection');
    const kept = names(sentryIntegrations(defaults));
    expect(kept).not.toContain('OnUnhandledRejection');
    // ... and the one that reports the crash Node then raises.
    expect(kept).toContain('OnUncaughtException');
    expect(kept).not.toContain('Nest');
  });
});
