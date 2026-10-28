import { ConfigService } from '@nestjs/config';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Config, CoreEnv } from './core/config/core.env.js';
import { setupHttp } from './core/http/http-setup.js';
import { setupOpenApi } from './openapi.js';
import { switchedOn } from './platform/switches.js';
import { setupRealtime } from './platform/realtime/realtime-adapter.js';

/** What main.ts and the tests both apply to the application. */
export async function configureApp(
  app: NestNodeApplication,
  { openApi = true }: { openApi?: boolean } = {},
) {
  setupHttp(app);
  // REALTIME=off: no gateway, so no socket.io adapter either.
  if (switchedOn('REALTIME')) {
    await setupRealtime(app);
  }
  if (
    openApi &&
    app.get<Config<CoreEnv>>(ConfigService).get('OPENAPI', { infer: true })
  ) {
    setupOpenApi(app);
  }
}
