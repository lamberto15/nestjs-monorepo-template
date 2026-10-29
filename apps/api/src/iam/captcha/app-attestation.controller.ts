import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import {
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import { z } from 'zod';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import { AppAttestationService } from './app-attestation.service.js';

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const challengeSchema = z.object({
  challenge: z
    .string()
    .describe(
      'One-time: bind one proof to it (App Attest: its SHA-256 as clientDataHash; Play Integrity: the nonce).',
    ),
  expiresIn: z.number().int().describe('Seconds until it expires.'),
});
const keySchema = z.object({
  keyId: base64url
    .max(64)
    .describe("App Attest's key id (`generateKey()`), base64url."),
  attestation: base64url
    .max(16_384)
    .describe("`attestKey()`'s attestation object, base64url."),
  challenge: base64url.max(64),
});

/**
 * App attestation (APP_ATTESTATION; docs/auth.md, "App attestation"):
 * the challenges a native app binds its proofs to, and an iOS install's
 * App Attest key. 404 while off.
 */
@ApiTags('auth')
@Public()
@AllowInMaintenance() // a sign-in may need a proof
@Controller('auth/app-attestation')
export class AppAttestationController {
  constructor(private readonly attestation: AppAttestationService) {}

  @Throttle({ default: { limit: 30, ttl: minutes(1) } })
  @Post('challenge')
  @HttpCode(200)
  @ApiOperation({ summary: 'A one-time challenge for an app attestation' })
  @ApiOkResponse({ standardSchema: challengeSchema })
  @ApiNotFoundResponse({ description: 'App attestation is off.' })
  challenge() {
    return this.attestation.challenge();
  }

  @Throttle({ default: { limit: 10, ttl: minutes(15) } })
  @Post('keys')
  @HttpCode(204)
  @ApiOperation({
    summary: "Register an iOS install's App Attest key",
    description:
      'Once per key, with an attestation made over a challenge: Apple vouches that the key belongs to a genuine build of an app of PASSKEY_APPLE_APPS. Its assertions then go in `X-App-Attestation`.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({
    description:
      '`attestation_invalid` (`reason`: `challenge`, `format`, `certificate`, `nonce`, `key`, `app`, `authenticator`).',
  })
  @ApiNotFoundResponse({ description: 'App attestation is off.' })
  async register(@Body({ schema: keySchema }) body: z.infer<typeof keySchema>) {
    await this.attestation.registerAppleKey(body);
  }
}
