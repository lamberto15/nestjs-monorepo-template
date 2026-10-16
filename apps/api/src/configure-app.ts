import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Config, CoreEnv } from './core/config/core.env.js';
import { setupHttp } from './core/http/http-setup.js';
import { setupOpenApi } from './openapi.js';
import { setupRealtime } from './platform/realtime/realtime-adapter.js';

/** What main.ts and the tests both apply to the application. */
export async function configureApp(
  app: NestExpressApplication,
  { openApi = true }: { openApi?: boolean } = {},
) {
  setupHttp(app);
  await setupRealtime(app);
  if (
    openApi &&
    app.get<Config<CoreEnv>>(ConfigService).get('OPENAPI', { infer: true })
  ) {
    setupOpenApi(app);
  }
}
