import { Logger } from '@nestjs/common';
import { sentryEnabled } from './telemetry.js';

/** What an error report carries besides the error: ids that find the logs. */
export interface ErrorContext {
  requestId?: string;
  code?: string;
  status?: number;
}

/**
 * Where unexpected errors (the 5xx the problem-details filter answers) are
 * reported. An abstract class, so it is its own injection token: inject
 * `ErrorTracker` and call `capture()` for an error you handle but still want
 * seen. The implementation follows the configuration, and the app runs the
 * same with none: Sentry when `SENTRY_DSN` is set, otherwise nothing.
 * Another tracker (Rollbar, Bugsnag) is one more subclass and a line in
 * `errorTracker()`.
 */
export abstract class ErrorTracker {
  abstract capture(error: unknown, context?: ErrorContext): void;
}

/** No error tracking configured. */
export class NoopErrorTracker extends ErrorTracker {
  capture() {}
}

/**
 * Sentry (`@sentry/nestjs`, started by instrument.ts). Reports through the
 * SDK's own `captureException`; scrubbing happens in its `beforeSend`
 * (sentry.ts), so what is attached here is masked like everything else.
 * The SDK is imported on the first report, so an app without a DSN never
 * loads it.
 */
export class SentryErrorTracker extends ErrorTracker {
  private readonly logger = new Logger('ErrorTracker');
  private sdk?: Promise<typeof import('@sentry/nestjs')>;

  capture(error: unknown, context: ErrorContext = {}) {
    this.sdk ??= import('@sentry/nestjs');
    this.sdk
      .then((Sentry) =>
        Sentry.captureException(error, {
          tags: { requestId: context.requestId, code: context.code },
          extra: { status: context.status },
        }),
      )
      .catch((reason: unknown) =>
        this.logger.warn(
          `Could not report an error: ${reason instanceof Error ? reason.message : String(reason)}`,
        ),
      );
  }
}

/** The tracker the configuration asks for (a provider's `useFactory`). */
export const errorTracker = (env: NodeJS.ProcessEnv = process.env) =>
  sentryEnabled(env) ? new SentryErrorTracker() : new NoopErrorTracker();
