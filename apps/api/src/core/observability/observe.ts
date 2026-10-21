import { ConditionalModule, ConfigService } from '@nestjs/config';
import * as nestMail from '@nestjs/mail';
import { createObserveModule } from '@nestjs/observe';
import { appEnv, type Config, type CoreEnv } from '../config/core.env.js';
import { logRedaction } from '../logging/redaction.js';

/**
 * NestJS Observe (@nestjs/observe): traces of every request, job, workflow
 * step and outgoing call, runtime metrics and errors, with the trace id in
 * every log line. A hosted service: it starts only when OBSERVE_APP_KEY and
 * OBSERVE_APP_SECRET are set (your project's API keys page), and the app runs
 * the same without it.
 *
 * `x-request-id` from Caddy or the client becomes the trace id (the SDK's
 * default), so one id follows a request through the proxy, the logs and the
 * traces.
 */
/**
 * The mail transport classes @nestjs/mail exports (every `*Transport`, found
 * by name so a transport added in a later release is covered).
 */
const mailTransportClasses = Object.entries(nestMail)
  .filter(
    ([name, value]) =>
      name.endsWith('Transport') && typeof value === 'function',
  )
  .map(([, value]) => value as abstract new (...args: never[]) => unknown);

/** The key @nestjs/locks stamps on a method wrapped by @OnOneInstance()/@WithoutOverlapping(). */
const LOCK_JOB_KEY = 'nestjs:locks:job';

/** Whether the instance's class has a method @nestjs/locks wrapped. */
const hasLockedJob = (instance: object) => {
  for (
    let proto = Object.getPrototypeOf(instance) as object | null;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      const method = Object.getOwnPropertyDescriptor(proto, key)
        ?.value as unknown;
      if (
        typeof method === 'function' &&
        Object.getOwnPropertySymbols(method).some(
          (symbol) => symbol.description === LOCK_JOB_KEY,
        )
      ) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Providers Observe must leave unproxied (its `skipInstrumentation`). Observe
 * runs a method with its proxy as `this`, which breaks two things keyed by the
 * real instance:
 *
 * - the mail transports: @nestjs/mail compiles `#field` to a WeakMap
 *   (`__classPrivateFieldGet`), which Observe doesn't detect as a private
 *   member, so every send throws "Cannot read private member";
 * - every job decorated with @OnOneInstance()/@WithoutOverlapping():
 *   @nestjs/locks finds the job's runner in a WeakMap keyed by the instance
 *   (`jobRunners.get(this)`), so the call throws before the job runs.
 *
 * Lock-decorated classes are found by the marker @nestjs/locks puts on the
 * method, so a new job is covered without being listed. Custom code, because
 * Observe has no per-class opt-out other than this hook (issue #392). The
 * cost: no spans for those classes' own methods; their outgoing calls still
 * trace. Drop this once @nestjs/observe or @nestjs/locks handles proxies.
 */
export const skipObserve = (instance: unknown): boolean =>
  typeof instance === 'object' &&
  instance !== null &&
  (mailTransportClasses.some((type) => instance instanceof type) ||
    hasLockedJob(instance));

export const { ObserveModule, ObserveInstrument } = createObserveModule({
  skipInstrumentation: skipObserve,
});

/** Whether Observe is configured: main.ts passes `ObserveInstrument` only then. */
export const observeEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  Boolean(env.OBSERVE_APP_KEY && env.OBSERVE_APP_SECRET);

/** The Observe module when it's configured, nothing otherwise. */
export const observability = () =>
  ConditionalModule.registerWhen(
    ObserveModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: Config<CoreEnv>) => ({
        appKey: config.get('OBSERVE_APP_KEY', { infer: true })!,
        appSecret: config.get('OBSERVE_APP_SECRET', { infer: true })!,
        serviceId: config.get('SERVICE_NAME', { infer: true }),
        // Set by the image's GIT_SHA build argument; empty in a local build.
        serviceVersion: process.env.GIT_SHA || undefined,
        http: {
          tags: { env: appEnv(config) },
          getUserId: (req: { user?: { kind?: string; id?: string } | null }) =>
            req.user ? `${req.user.kind}:${req.user.id}` : 'anonymous',
          ignore: ['/health', '/health/live'],
        },
        // Passwords, tokens and keys never leave the process: the SDK's own
        // rules, plus the app's registry (core/logging/redaction.ts), so the
        // captured errors and requests mask the same names and shapes as
        // the logs (Observe replaces a pattern's whole match, so there a
        // `name=value` loses its name too).
        redaction: {
          enabled: true,
          useDefaultPatterns: true,
          keys: logRedaction.keys(),
          patterns: logRedaction.patterns(),
        },
      }),
    }),
    observeEnabled,
    // As the scheduler's in core.module.ts: 5 s ran out under load.
    { debug: false, timeout: 60_000 },
  );
