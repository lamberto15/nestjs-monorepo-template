import { trace } from '@opentelemetry/api';
import { createLogger } from './logging.js';
import { LogRedaction } from './redaction.js';
import {
  onTelemetryRejected,
  resetTelemetryHealth,
} from '../observability/telemetry-health.js';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';

const inSpan = () =>
  vi.spyOn(trace, 'getActiveSpan').mockReturnValue({
    spanContext: () => ({
      traceId: TRACE_ID,
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
    }),
  } as never);

const capture = () => {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
};

describe('the logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetTelemetryHealth();
  });

  it('puts the active trace id in a JSON line', () => {
    inSpan();
    const lines = capture();
    createLogger({ LOG_FORMAT: 'json' }, {}, new LogRedaction()).log('hello');
    expect(JSON.parse(lines.join('')).traceId).toBe(TRACE_ID);
  });

  it('puts it in a text line too', () => {
    inSpan();
    const lines = capture();
    createLogger({ LOG_FORMAT: 'text' }, {}, new LogRedaction()).log('hello');
    expect(lines.join('')).toContain(`[trace ${TRACE_ID}]`);
  });

  it('adds nothing outside a span', () => {
    const lines = capture();
    createLogger({ LOG_FORMAT: 'json' }, {}, new LogRedaction()).log('hello');
    expect(JSON.parse(lines.join(''))).not.toHaveProperty('traceId');
  });

  it("counts NestJS Observe's refused uploads", () => {
    capture();
    const heard: string[] = [];
    onTelemetryRejected((target, status) => heard.push(`${target}:${status}`));
    createLogger({}, {}, new LogRedaction()).error(
      'Error: Telemetry rate-limited (429) - quota reached.',
    );
    expect(heard).toEqual(['observe:429']);
  });
});
