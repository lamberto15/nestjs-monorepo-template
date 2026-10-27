import { Controller, Get, Header, VERSION_NEUTRAL } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import { ApiExcludeController } from '@nestjs/swagger';
import { AllowInMaintenance } from '../http/maintenance.js';

/**
 * `GET /health/version`: the commit this API was built from (`GIT_SHA`),
 * for the web app's build details in the signed-in account menu
 * (docs/build-version.md). Signed in only, unlike the health checks beside
 * it: a public answer would tell anyone which revision of this public
 * template a deployment runs. The menu's request is same-origin, so it
 * carries the session cookie; a token or an API key works too. Its own
 * controller because HealthController is `@Public()` as a whole.
 */
@ApiExcludeController()
@AllowInMaintenance()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class BuildVersionController {
  @Get('version')
  @Can.Anyone()
  @Header('Cache-Control', 'no-store')
  version() {
    return { sha: process.env.GIT_SHA ?? '' };
  }
}
