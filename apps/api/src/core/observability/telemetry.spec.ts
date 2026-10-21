import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import {
  errorTracker,
  NoopErrorTracker,
  SentryErrorTracker,
} from './error-tracker.js';
import {
  countRefusals,
  otelEnabled,
  sentryEnabled,
  startOpenTelemetry,
} from './telemetry.js';

describe('switches', () => {
  it('are off until configured', () => {
    expect(otelEnabled({})).toBe(false);
    expect(otelEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: ' ' })).toBe(false);
    expect(otelEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' })).toBe(
      true,
    );
    expect(sentryEnabled({})).toBe(false);
    expect(
      sentryEnabled({ SENTRY_DSN: 'https://k@o.ingest.sentry.io/1' }),
    ).toBe(true);
  });

  it('choose the error tracker by the DSN', () => {
    expect(errorTracker({})).toBeInstanceOf(NoopErrorTracker);
    expect(
      errorTracker({ SENTRY_DSN: 'https://k@o.ingest.sentry.io/1' }),
    ).toBeInstanceOf(SentryErrorTracker);
  });
});

describe('countRefusals', () => {
  const exporterThatFailsWith = (error: unknown) => ({
    export(
      _items: unknown,
      done: (result: { code: number; error?: unknown }) => void,
    ) {
      done({ code: 1, error });
    },
  });

  it('counts a collector that refuses, and still answers the SDK', () => {
    const record = vi.fn();
    const done = vi.fn();
    countRefusals(exporterThatFailsWith({ code: 429 }), record).export(
      [],
      done,
    );
    expect(record).toHaveBeenCalledWith('otlp', 429);
    expect(done).toHaveBeenCalledWith({ code: 1, error: { code: 429 } });
  });

  it('does not count a success', () => {
    const record = vi.fn();
    const exporter = {
      export(_items: unknown, done: (result: { code: number }) => void) {
        done({ code: 0 });
      },
    };
    countRefusals(exporter, record).export([], vi.fn());
    expect(record).not.toHaveBeenCalled();
  });
});

describe('OpenTelemetry against a collector', () => {
  let collector: Server;
  const received: string[] = [];

  beforeAll(async () => {
    collector = createServer((request, response) => {
      received.push(`${request.method} ${request.url}`);
      request.resume();
      request.on('end', () => response.end('{}'));
    });
    await new Promise<void>((resolve) =>
      collector.listen(0, '127.0.0.1', resolve),
    );
  });
  afterAll(() => new Promise((resolve) => collector.close(resolve)));

  it(
    'exports the trace of a request it served',
    { timeout: 30_000 },
    async () => {
      const { port } = collector.address() as AddressInfo;
      // The exporters read the process's environment, as in the app.
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', `http://127.0.0.1:${port}`);
      vi.stubEnv('SERVICE_NAME', 'telemetry-spec');
      const sdk = await startOpenTelemetry();
      expect(sdk).toBeDefined();
      // http is patched as it loads: this server and request make spans.
      // A library's own require('http'), as Express does: patched as it loads.
      const { createServer: createApp, get } = createRequire(import.meta.url)(
        'node:http',
      ) as typeof import('node:http');
      const app = createApp((_request, response) => response.end('ok'));
      await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
      await new Promise<void>((resolve, reject) =>
        get(
          `http://127.0.0.1:${(app.address() as AddressInfo).port}/ping`,
          (response) => {
            response.resume();
            response.on('end', resolve);
          },
        ).on('error', reject),
      );
      await new Promise((resolve) => app.close(resolve));
      await sdk!.shutdown();
      expect(received).toContain('POST /v1/traces');
      expect(process.env.OTEL_SERVICE_NAME).toBe('telemetry-spec');
    },
  );
});
