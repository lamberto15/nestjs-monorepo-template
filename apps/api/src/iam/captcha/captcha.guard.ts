import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiForbiddenResponse, ApiHeader } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CaptchaService } from './captcha.service.js';

/** The header the widget's token travels in. */
export const CAPTCHA_HEADER = 'X-Captcha-Token';

export interface CaptchaOptions {
  /** The widget's `data-action` on the page that calls this route: a token minted for another is refused. */
  action: string;
  /**
   * What `after-failures` counts here: `failures` (an answer that is a 4xx:
   * a wrong password, an unknown account) or `requests` (every request: a
   * route that always answers 202 so as to reveal nothing).
   */
  count: 'failures' | 'requests';
}

const CAPTCHA = Symbol('captcha');

/**
 * A public route bots go for (sign-in, sign-up, the magic-link request,
 * forgot password): with CAPTCHA_MODE on, it wants a challenge token in
 * `X-Captcha-Token`, always or after N failed attempts from the address or
 * for the account (docs/auth.md, "Bot protection"). Off (the default
 * without keys): nothing changes. Documented in OpenAPI as a header, so the
 * bodies and the generated client stay as they are.
 *
 * Custom: @nestjs/throttler limits how often, not who; the global throttle
 * stays in front of this guard, so a flood is refused before any token is
 * verified.
 */
export const Captcha = (options: CaptchaOptions) =>
  applyDecorators(
    SetMetadata(CAPTCHA, options),
    UseGuards(CaptchaGuard),
    ApiHeader({
      name: CAPTCHA_HEADER,
      required: false,
      description: `The challenge token (Cloudflare Turnstile, widget action \`${options.action}\`), when GET /auth/methods lists a captcha: always, or once a 403 \`captcha_required\` asked for one.`,
      schema: { type: 'string' },
    }),
    ApiForbiddenResponse({
      description:
        '`captcha_required`: solve the challenge (the problem names `provider`, `siteKey` and `action`) and send its token in `X-Captcha-Token`. `captcha_invalid`: the token was refused (`reason`: `invalid`, `duplicate`, `hostname`, `action`); render the widget again. Provider down: 503 `captcha_unavailable` (fail-closed), or 429 `rate_limited` past the fail-open allowance.',
    }),
  );

@Injectable()
export class CaptchaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly captcha: CaptchaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const options = this.reflector.getAllAndOverride<
      CaptchaOptions | undefined
    >(CAPTCHA, [context.getHandler(), context.getClass()]);
    if (
      !options ||
      context.getType() !== 'http' ||
      this.captcha.mode === 'off'
    ) {
      return true;
    }
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const email = (request.body as { email?: unknown } | undefined)?.email;
    const subject = {
      ip: request.ip ?? '',
      email: typeof email === 'string' ? email : undefined,
      action: options.action,
    };
    if (options.count === 'failures') {
      // The attempt is counted (reserved) in check(), before anything is
      // judged; an answer that is no failure gives it back. A refused token
      // is a 4xx and stays counted; a dropped connection (no 'finish')
      // keeps the reservation: conservative, and no path skips counting.
      response.once('finish', () => {
        if (response.statusCode < 400) {
          void this.captcha.release(subject);
        }
      });
    }
    await this.captcha.check(headerValue(request, CAPTCHA_HEADER), subject);
    return true;
  }
}

/** The header's value, trimmed; undefined when absent or empty. */
function headerValue(request: Request, name: string) {
  const raw = request.headers[name.toLowerCase()];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value || undefined;
}
