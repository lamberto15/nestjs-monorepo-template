import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { tracing } from '@opentelemetry/sdk-node';
import { LogRedaction } from '../logging/redaction.js';
import {
  errorTracker,
  NoopErrorTracker,
  SentryErrorTracker,
} from './error-tracker.js';
import {
  countRefusals,
  exportFailureStatus,
  otelEnabled,
  redactedQueryParams,
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

  it('reads the status of the failures the exporters really make', () => {
    // OTLPExporterError(statusMessage, statusCode): a 401 or 403.
    expect(exportFailureStatus({ name: 'OTLPExporterError', code: 401 })).toBe(
      401,
    );
    // A 429 (or 502, 503, 504) comes back "retryable", with no code.
    expect(
      exportFailureStatus(new Error('Export failed with retryable status')),
    ).toBe(429);
    // A timeout or a refused connection is not a collector turning us away.
    expect(exportFailureStatus(new Error('Request timed out'))).toBeUndefined();
    expect(exportFailureStatus(undefined)).toBeUndefined();
  });
});

describe('countRefusals on a real OTLP exporter', () => {
  let collector: Server;
  let status = 429;

  beforeAll(async () => {
    collector = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        // Retry-After far beyond the exporter's timeout: it gives up at once
        // instead of waiting out its backoff.
        response.writeHead(status, { 'Retry-After': '3600' });
        response.end();
      });
    });
    await new Promise<void>((resolve) =>
      collector.listen(0, '127.0.0.1', resolve),
    );
  });
  afterAll(() => new Promise((resolve) => collector.close(resolve)));

  // The status as the exporter reports it: 401 and 403 with their code, 429
  // as a "retryable" failure with none (the fake in the test above never
  // showed the difference).
  it.each([401, 403, 429])(
    'counts a collector that answers %i',
    async (code) => {
      status = code;
      const { port } = collector.address() as AddressInfo;
      const record = vi.fn();
      const provider = new tracing.BasicTracerProvider({
        spanProcessors: [
          new tracing.SimpleSpanProcessor(
            countRefusals(
              new OTLPTraceExporter({
                url: `http://127.0.0.1:${port}/v1/traces`,
                timeoutMillis: 5_000,
              }),
              record,
            ),
          ),
        ],
      });
      provider.getTracer('telemetry-spec').startSpan('refused').end();
      await vi.waitFor(() => expect(record).toHaveBeenCalledWith('otlp', code));
      await provider.shutdown();
    },
  );
});

describe('redactedQueryParams', () => {
  it("lists the registry's query names and the instrumentation's own", () => {
    const names = redactedQueryParams(new LogRedaction());
    // The OIDC callbacks' query: the authorization code and its state.
    expect(names).toEqual(expect.arrayContaining(['code', 'state']));
    // A plain field name masks as a query parameter too.
    expect(names).toEqual(expect.arrayContaining(['token', 'password']));
    // The instrumentation's defaults, which a list replaces.
    expect(names).toEqual(
      expect.arrayContaining(['sig', 'X-Amz-Signature', 'AWSAccessKeyId']),
    );
    // A body field is no query parameter.
    expect(names.some((name) => name.includes('.'))).toBe(false);
  });
});

describe('OpenTelemetry against a collector', () => {
  let collector: Server;
  let directory: string;
  const received: string[] = [];
  const keys: (string | string[] | undefined)[] = [];
  const traces: string[] = [];

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'telemetry-spec-'));
    collector = createServer((request, response) => {
      received.push(`${request.method} ${request.url}`);
      const body: Buffer[] = [];
      request.on('data', (chunk: Buffer) => body.push(chunk));
      request.on('end', () => {
        if (request.url === '/v1/traces') {
          keys.push(request.headers['x-collector-key']);
          traces.push(Buffer.concat(body).toString());
        }
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) =>
      collector.listen(0, '127.0.0.1', resolve),
    );
  });
  afterAll(async () => {
    rmSync(directory, { recursive: true, force: true });
    await new Promise((resolve) => collector.close(resolve));
  });

  it(
    'exports the trace of a request it served, without its secrets',
    { timeout: 30_000 },
    async () => {
      const { port } = collector.address() as AddressInfo;
      // The exporters read the process's environment, as in the app.
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', `http://127.0.0.1:${port}`);
      vi.stubEnv('SERVICE_NAME', 'telemetry-spec');
      // The collector's credential in a file, as a Docker secret: read before
      // the environment is validated, so the SDK reads it itself.
      const headersFile = join(directory, 'otlp-headers');
      writeFileSync(headersFile, 'x-collector-key=read-from-a-file\n');
      vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS_FILE', headersFile);
      vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', undefined);
      const sdk = await startOpenTelemetry();
      expect(sdk).toBeDefined();
      // Only for the moment the exporters were built: the validation refuses
      // the variable beside its file.
      expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
      // http is patched as it loads: this server and request make spans.
      // A library's own require('http'), as Express does: patched as it loads.
      const { createServer: createApp, get } = createRequire(import.meta.url)(
        'node:http',
      ) as typeof import('node:http');
      const app = createApp((_request, response) => response.end('ok'));
      await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
      await new Promise<void>((resolve, reject) =>
        get(
          // An OIDC callback's query: the code and the state are secrets.
          `http://127.0.0.1:${(app.address() as AddressInfo).port}/ping?code=THE-CODE-1234&state=THE-STATE-5678&page=2`,
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
      expect(keys).toContain('read-from-a-file');
      // The span of the request served and the one of the request made.
      const exported = traces.join('\n');
      expect(exported).toContain('page=2');
      expect(exported).not.toContain('THE-CODE-1234');
      expect(exported).not.toContain('THE-STATE-5678');
    },
  );
});
