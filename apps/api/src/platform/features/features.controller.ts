import { Controller, Get } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { DuringMfaEnrollment } from '../../iam/auth/mfa-enrollment.guard.js';
import { DuringOnboarding } from '../../iam/auth/onboarding.js';
import { featuresSchema } from './features.schemas.js';
import { FeaturesService } from './features.service.js';

/** Which deployment switches are on, for a client to hide what is off. */
@ApiTags('features')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Controller('features')
export class FeaturesController {
  constructor(private readonly features: FeaturesService) {}

  @Get()
  @Can.Anyone() // Any signed-in caller: it says nothing about the data.
  // Deployment-wide switches: the web shell reads them to draw the two-factor setup.
  @DuringMfaEnrollment()
  @DuringOnboarding()
  @ApiOperation({
    summary: 'Which switches are on in this deployment',
    description:
      'The deployment switches (`REALTIME`, `WEBHOOKS`, `REPORTS`, `USAGE`, `IMPERSONATION`, `AUTH_MFA`, `API_CLIENTS`), the sign-in options (`PASSKEYS`, `AUTH_SIGN_UP`, `AUTH_MAGIC_LINK`), whether PDF documents are set up, whether the AI helper has a provider (`ai`; a tenant opts in with the public setting `ai.enabled`), `TENANCY` and `LOCALES`. A switch that is off leaves its routes out (404) or refuses them (404 `feature_off`, 503 `documents_unavailable`). Read at startup: a change needs a restart.',
  })
  @ApiOkResponse({ standardSchema: featuresSchema })
  list() {
    return this.features.current();
  }
}
