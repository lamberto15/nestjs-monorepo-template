// First: .env.development into process.env, before the modules below are evaluated.
import './dev-env.js';
// Second: OpenTelemetry and Sentry patch the libraries loaded after them.
import './core/observability/instrument.js';
import type { Server } from 'node:http';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';
import { createLogger } from './core/logging/logging.js';
import {
  ObserveInstrument,
  observeEnabled,
} from './core/observability/observe.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // rawBody: incoming webhooks are verified on the bytes that were signed, not on a re-serialized body.
    rawBody: true,
    logger: createLogger(),
    // Traces every request, job and outgoing call when NestJS Observe is configured.
    ...(observeEnabled() && { instrument: ObserveInstrument }),
  });
  const role = process.env.APP_ROLE ?? 'all';
  await configureApp(app, { openApi: role !== 'worker' });
  // On SIGTERM, /health turns 503, then the workers (workflows, outbox,
  // webhooks, queues) finish what they started and hand the rest back.
  app.enableShutdownHooks();
  exitIfShutdownHangs(role, app);
  await app.listen(process.env.PORT ?? 3000);
  const url = await app.getUrl();
  Logger.log(
    role === 'worker'
      ? `Worker running (health: ${url}/health)`
      : `API: ${url}/v1 (OpenAPI: ${url}/api)${role === 'all' ? ', with the workers' : ''}`,
    'Bootstrap',
  );
}
/**
 * A hard deadline on shutdown. enableShutdownHooks() waits for every hook,
 * and NestJS has no timeout for them: one that never settles (a client
 * waiting for a server that is gone) would keep the process alive until
 * SIGKILL, logging nothing. So the first signal starts a timer that exits
 * with code 1 when the graceful shutdown hasn't finished in time. It is
 * unref'd: it never keeps a process alive that would otherwise exit. The
 * deadlines stay under the stop grace periods (compose.prod.yaml: api 30 s,
 * worker 60 s; Kubernetes' default is 30 s), and above what a healthy
 * shutdown takes: 5 s of /health 503, then up to 10 s for workflow steps,
 * and for a worker, the queue jobs it is running.
 *
 * It also closes keep-alive connections as they go idle, once the server has
 * stopped listening (see below).
 */
function exitIfShutdownHangs(role: string, app: NestExpressApplication) {
  const deadlineMs = role === 'api' ? 25_000 : 55_000;
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  const start = (signal: NodeJS.Signals) => {
    // NestJS re-sends the signal to end the process after its hooks: with a
    // listener of ours still attached, the signal would be ignored.
    for (const other of signals) {
      process.removeListener(other, start);
    }
    // Closing a client rejects the commands others left queued on it (the
    // socket.io Redis adapter's unsubscribes, never awaited): logged, so the
    // shutdown carries on instead of crashing half-way.
    process.on('unhandledRejection', (reason) =>
      Logger.warn(
        `During shutdown: ${reason instanceof Error ? reason.message : String(reason)}`,
        'Bootstrap',
      ),
    );
    // server.close() ends the idle keep-alive connections once, when it stops
    // listening; one that was serving a request then goes idle and would keep
    // the process alive until the deadline. Close those as they go idle.
    const server = app.getHttpServer() as Server;
    setInterval(() => {
      if (!server.listening) server.closeIdleConnections();
    }, 250).unref();
    setTimeout(() => {
      Logger.error(
        `Shutdown (${signal}) still not finished after ${deadlineMs / 1000} s: exiting now.`,
        'Bootstrap',
      );
      process.exit(1);
    }, deadlineMs).unref();
  };
  for (const signal of signals) {
    process.once(signal, start);
  }
}

await bootstrap();
