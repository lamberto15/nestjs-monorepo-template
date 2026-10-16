import { ConditionalModule, ConfigService } from '@nestjs/config';
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
export const { ObserveModule, ObserveInstrument } = createObserveModule();

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
