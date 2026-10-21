import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { Throttle, minutes } from '@nestjs/throttler';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import { SsoDiscovery } from './sso-discovery.service.js';

const discoverSchema = z.object({
  email: z
    .string()
    .trim()
    .max(320)
    .describe('What the person typed: only its domain is used.'),
});

const discoveredSchema = z.object({
  loginUrl: z
    .string()
    .nullable()
    .describe(
      'Navigate the browser here (add `?redirectTo=` a path of the web app). Null: sign in another way. The same for every address of a domain, whether it has an account or not.',
    ),
});

/**
 * The sign-in page's "Continue with SSO" (docs/auth.md, "Finding the
 * connection by address"): from an address, the login URL of the SSO
 * connection its domain's tenant set up. Public, before any sign-in, so it
 * tells nothing about accounts: only the domain is read (never the local
 * part, never `users`), the answer is the same for every address of a
 * domain, and no tenant's name or id is given beyond the URL the browser is
 * sent to. That a domain uses SSO is what its DNS record (verification)
 * publishes anyway.
 */
@ApiTags('auth')
@Public()
@AllowInMaintenance()
@Controller('auth/sso')
export class SsoDiscoveryController {
  constructor(private readonly discovery: SsoDiscovery) {}

  @Throttle({ default: { limit: 10, ttl: minutes(1) } })
  @Post('discover')
  @HttpCode(200)
  @ApiOperation({
    summary: "The SSO login URL for an address's domain, if it has one",
  })
  @ApiOkResponse({ standardSchema: discoveredSchema })
  async discover(
    @Body({ schema: discoverSchema }) body: z.infer<typeof discoverSchema>,
  ) {
    return { loginUrl: await this.discovery.loginUrl(body.email) };
  }
}
