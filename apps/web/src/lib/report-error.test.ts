import { ApiError } from '@nestjs-monorepo-template/api-client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {
  isNetworkError,
  listenForUncaughtErrors,
  reportClientError,
  reportIdOf,
  resetErrorReports,
  rootErrorHandlers,
} from '@/lib/report-error';

let logged: MockInstance<typeof console.error>;
beforeEach(() => {
  resetErrorReports();
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The report lines sent (the console, until #751 says where else). */
const sent = () => logged.mock.calls.map(([line]) => String(line));

describe('reportClientError', () => {
  it('reports an error once, under one id, wherever it was heard', () => {
    const error = new Error('boom');
    const id = reportClientError(error, 'caught');
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    // The route's error page hears the same error React's boundary did.
    expect(reportClientError(error, 'route')).toBe(id);
    expect(reportIdOf(error)).toBe(id);
    expect(sent()).toEqual([`[${id}] caught error`]);
  });

  it('sends at most 20 a minute: a loop does not flood the reports', () => {
    for (let n = 0; n < 25; n += 1) {
      reportClientError(new Error(`boom ${n}`), 'window');
    }
    expect(sent()).toHaveLength(20);
  });

  it('gives React root callbacks a report each', () => {
    const error = new Error('render');
    rootErrorHandlers.onUncaughtError(error);
    rootErrorHandlers.onCaughtError(error);
    rootErrorHandlers.onRecoverableError(new Error('hydration'));
    expect(sent()).toEqual([
      expect.stringMatching(/ uncaught error$/),
      expect.stringMatching(/ recoverable error$/),
    ]);
  });
});

describe('the window', () => {
  it("reports an uncaught error and an unhandled rejection, not the API's answers or noise", () => {
    const stop = listenForUncaughtErrors(window);
    const rejection = (reason: unknown) => {
      const event = new Event('unhandledrejection') as PromiseRejectionEvent;
      Object.defineProperty(event, 'reason', { value: reason });
      window.dispatchEvent(event);
    };
    window.dispatchEvent(
      new ErrorEvent('error', { error: new Error('bug'), message: 'bug' }),
    );
    rejection(new Error('async bug'));
    // Noise: logged by the API already, the browser's notice, a hidden
    // cross-origin error, a dropped connection.
    rejection(new ApiError({ status: 409, code: 'conflict', detail: 'Taken' }));
    window.dispatchEvent(
      new ErrorEvent('error', {
        message:
          'ResizeObserver loop completed with undelivered notifications.',
      }),
    );
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
    rejection(new TypeError('Failed to fetch'));
    stop();

    expect(sent()).toEqual([
      expect.stringMatching(/ window error$/),
      expect.stringMatching(/ rejection error$/),
    ]);
  });
});

describe('isNetworkError', () => {
  it("knows each browser's words for a fetch that never reached the API", () => {
    for (const message of [
      'Failed to fetch',
      'NetworkError when attempting to fetch resource.',
      'Load failed',
    ]) {
      expect(isNetworkError(new TypeError(message))).toBe(true);
    }
    expect(
      isNetworkError(new TypeError('Cannot read properties of undefined')),
    ).toBe(false);
    expect(isNetworkError(new Error('Failed to fetch'))).toBe(false);
  });
});
