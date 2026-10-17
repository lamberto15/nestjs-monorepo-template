import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Ip,
  Patch,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { AccountService } from '../account/account.service.js';
import {
  CurrentSession,
  CurrentUser,
  EmailVerificationService,
  MfaService,
  Public,
  type SessionRecord,
  SignInService,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { ConfigService } from '@nestjs/config';
import { I18nContext, I18nService, t } from '@nestjs/i18n';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import type { CoreEnv } from '../../core/config/core.env.js';
import { AccessService } from '../access/access.service.js';
import { PermissionCatalog } from '../access/permission-catalog.js';
import {
  email,
  locale,
  newPassword,
  signedInSchema,
  timezone,
  userSchema,
} from '../account/account.schemas.js';
import { ImpersonationService } from '../account/impersonation.service.js';
import { notWhileImpersonating } from '../account/account.schemas.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { Captcha } from '../captcha/captcha.guard.js';
import { CaptchaService } from '../captcha/captcha.service.js';
import { oidcProviders } from '../account/oidc.providers.js';
import type { IamEnv } from '../iam.env.js';
import { ReauthenticationService } from '../account/reauthentication.service.js';
import { SIGN_IN_METHODS } from './authentication-method.js';
import type { UserPrincipal } from './principal.js';
import { SessionOnly, UserOnly } from './user-only.decorator.js';
import { UsersRepository } from './users.repository.js';

const signInSchema = z.object({
  email: email.meta({ example: 'admin@example.com' }),
  password: z.string().min(1).max(256),
});

const signUpSchema = z.object({
  email,
  name: z.string().trim().min(1).max(120),
  password: newPassword,
  locale: locale.optional(),
  timezone: timezone.optional(),
});

const mfaVerifySchema = z
  .object({
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    recoveryCode: z.string().min(1).max(64).optional(),
  })
  .refine(
    (body) => body.code || body.recoveryCode,
    'Send a code or a recoveryCode',
  );

const profileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  locale: locale
    .nullable()
    .optional()
    .describe("null: the request's language."),
  timezone: timezone
    .nullable()
    .optional()
    .describe("null: the app's time zone."),
});

const meSchema = z.object({
  user: userSchema,
  tenant: z
    .object({ id: z.string(), slug: z.string(), name: z.string() })
    .nullable()
    .describe('The tenant this session or token acts in; null: none.'),
  mfaEnabled: z.boolean(),
  authentication: z
    .object({
      via: z.enum(['session', 'token']),
      method: z
        .enum(SIGN_IN_METHODS)
        .nullable()
        .describe('How this session or token was signed in.'),
      provider: z.string().nullable(),
      mfa: z.boolean().describe('A second factor was verified.'),
      authenticatedAt: z.iso.datetime().nullable(),
      recentUntil: z.iso
        .datetime()
        .nullable()
        .describe(
          'Until when the sensitive routes accept it without a re-authentication (POST /auth/reauthenticate); past, or null, they want one now.',
        ),
    })
    .nullable(),
  can: z
    .record(z.string(), z.boolean())
    .describe(
      'Every action of the permission catalog as "Subject.action": true when any of the user\'s permissions allows it, on some records at least.',
    ),
});

const methodsSchema = z.object({
  password: z.literal(true),
  signUp: z.boolean(),
  magicLink: z.boolean(),
  passkeys: z
    .boolean()
    .describe(
      'Sign in with a passkey: POST /auth/passkeys/sign-in/options, then /auth/passkeys/sign-in.',
    ),
  providers: z
    .array(z.string())
    .describe('Start with GET /auth/oidc/{provider}/login.'),
  captcha: z
    .object({
      provider: z.string().describe('`turnstile`; `stub` outside production.'),
      siteKey: z
        .string()
        .nullable()
        .describe('Render the widget with it (null: the stub).'),
      mode: z.enum(['always', 'after-failures']),
    })
    .nullable()
    .describe(
      "Bot protection on sign-in (and its two-factor step), sign-up, the magic-link request and forgot password: send the widget's token in `X-Captcha-Token`, always, or when a 403 `captcha_required` asks for one. null: off.",
    ),
});

/**
 * Signing in and out, and who is signed in. Browsers get a session cookie
 * (`__Host-sid`: HttpOnly, Secure, SameSite=Lax); a frontend on another
 * origin is listed in CORS_ORIGINS and sends it with `credentials: 'include'`.
 * Mobile apps and CLIs use tokens instead (POST /auth/token).
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly account: AccountService,
    private readonly accounts: UsersRepository,
    private readonly signInService: SignInService,
    private readonly emailVerification: EmailVerificationService,
    private readonly mfa: MfaService,
    private readonly impersonation: ImpersonationService,
    private readonly i18nContext: I18nContext,
    private readonly i18n: I18nService,
    private readonly access: AccessService,
    private readonly catalog: PermissionCatalog,
    private readonly config: ConfigService<IamEnv & CoreEnv, true>,
    private readonly reauthentication: ReauthenticationService,
    private readonly captcha: CaptchaService,
    private readonly tenancy: Tenancy,
  ) {}

  @Public()
  @Get('methods')
  @ApiOperation({ summary: 'How users can sign in here, for the sign-in page' })
  @ApiOkResponse({ standardSchema: methodsSchema })
  methods() {
    return {
      password: true as const,
      signUp: this.config.get('AUTH_SIGN_UP', { infer: true }),
      magicLink: this.config.get('AUTH_MAGIC_LINK', { infer: true }),
      passkeys: this.config.get('PASSKEYS', { infer: true }),
      providers: Object.keys(oidcProviders(this.config)),
      captcha: this.captcha.settings(),
    };
  }

  // Five tries per email and IP every 15 minutes; a challenge when CAPTCHA_MODE asks.
  @Public()
  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  @Captcha({ action: 'sign-in', count: 'failures' })
  @Post('sign-in')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign in with a password: sets the session cookie',
    description:
      'A session ends after 12 hours, or 2 hours without a request. An unknown email and a wrong password get the same answer. With two-factor on, the answer says mfaRequired: finish with POST /auth/mfa/verify.',
  })
  @ApiOkResponse({ standardSchema: signedInSchema })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password.' })
  @ApiTooManyRequestsResponse({
    description:
      'More than 5 attempts for this email from this IP in 15 minutes.',
  })
  async signIn(
    @Body({ schema: signInSchema }) body: z.infer<typeof signInSchema>,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    // Audited; a new device is told to the user (AccountService).
    return this.account.signInWithPassword(body.email, body.password, {
      ip,
      userAgent,
    });
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  @Captcha({ action: 'sign-up', count: 'requests' })
  @Post('sign-up')
  @ApiOperation({
    summary:
      'Create an account (when AUTH_SIGN_UP=on); it signs in once its address is verified',
    description:
      "Verify first: no session is made, and the password signs in (or gets tokens) only after the user opened the link sent to the address and confirmed it with the same password (POST /auth/email/verify { token, password }). So nobody can sign up someone else's address and sign in as them once its owner clicks. The account has no tenant: a tenant invites it.",
  })
  @ApiCreatedResponse({ standardSchema: userSchema })
  @ApiBadRequestResponse({
    description: '`password_breached`: the password is in known data breaches.',
  })
  @ApiConflictResponse({ description: 'An account with this email exists.' })
  async signUp(
    @Body({ schema: signUpSchema }) body: z.infer<typeof signUpSchema>,
    @Ip() ip: string,
  ) {
    if (!this.config.get('AUTH_SIGN_UP', { infer: true })) {
      throw new ForbiddenException(t('auth.signUpClosed'));
    }
    if (await this.accounts.findActiveByEmail(body.email)) {
      throw new ConflictException(t('auth.emailTaken'));
    }
    const user = await this.account.signUp(
      {
        email: body.email,
        name: body.name,
        password: body.password,
        locale: this.supportedLocale(body.locale),
        timezone: body.timezone ?? null,
      },
      ip,
    );
    // Verify first: no session until the address is proved (CredentialsService).
    await this.emailVerification.send(user);
    const {
      active: _a,
      hasPassword: _p,
      createdAt: _c,
      updatedAt: _u,
      ...principal
    } = user;
    return principal;
  }

  /**
   * The second step of a sign-in with two-factor on: a code from the app, or
   * a recovery code. A wrong code is a failed sign-in for bot protection:
   * counted on the address and on the pending account's email and address,
   * the keys a wrong password counts on, and challenged the same way.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: minutes(15) } })
  @Captcha({ action: 'sign-in', count: 'failures', account: 'session' })
  @Post('mfa/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Finish signing in with a two-factor code' })
  @ApiOkResponse({ standardSchema: signedInSchema })
  @ApiUnauthorizedResponse({
    description: 'No pending sign-in, or a wrong code.',
  })
  async completeMfa(
    @Body({ schema: mfaVerifySchema }) body: z.infer<typeof mfaVerifySchema>,
  ) {
    // The session's time is now, when the sign-in completes (step-up).
    const issued = await this.account.completeMfa(body);
    if (!issued) {
      throw new UnauthorizedException(t('auth.invalidCode'));
    }
    return { signedIn: true, mfaRequired: false };
  }

  @Public()
  @Post('sign-out')
  @HttpCode(204)
  @ApiOperation({ summary: "Sign out: ends this browser's session" })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({ description: 'No session.' })
  async signOut() {
    if (!(await this.signInService.signOut())) {
      throw new UnauthorizedException();
    }
  }

  /**
   * Who is signed in, and what a frontend may show them. It hides what is
   * false; the routes check again, so hiding grants nothing.
   */
  @UserOnly()
  @Can.Anyone()
  @Get('me')
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiOperation({ summary: 'The signed-in user and what they may do' })
  @ApiOkResponse({ standardSchema: meSchema })
  @ApiUnauthorizedResponse({ description: 'Not signed in.' })
  async me(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: unknown,
  ) {
    const { authentication, recentUntil } =
      this.reauthentication.status(session);
    const tenant = user.tenantId
      ? await this.tenancy.find(user.tenantId)
      : undefined;
    return {
      user,
      tenant: tenant
        ? { id: tenant.id, slug: tenant.slug, name: tenant.name }
        : null,
      mfaEnabled: await this.mfa.isEnrolled(user.id),
      authentication: authentication && {
        ...authentication,
        authenticatedAt: authentication.authenticatedAt?.toISOString() ?? null,
        // An impersonation never counts as recent.
        recentUntil:
          user.impersonator || !recentUntil ? null : recentUntil.toISOString(),
      },
      can: Object.fromEntries(
        await Promise.all(
          Object.entries(this.catalog.subjects).flatMap(([subject, def]) =>
            Object.keys(def.actions).map(async (action) => [
              `${subject}.${action}`,
              // As AccessPolicy: no access management while impersonating.
              !(
                user.impersonator &&
                subject === 'Access' &&
                action !== 'readAudit'
              ) && (await this.access.can(user, action, subject)),
            ]),
          ),
        ),
      ) as Record<string, boolean>,
    };
  }

  @UserOnly()
  @Can.Anyone()
  @Patch('me')
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiOperation({
    summary: 'Change your name, language or time zone',
    description:
      'The language answers your requests and your emails; the time zone shows the times in your emails. Dates in the API stay UTC.',
  })
  @ApiOkResponse({ standardSchema: userSchema })
  @ApiBadRequestResponse({
    description: "A language this API doesn't speak, or an unknown time zone.",
  })
  async updateProfile(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: profileSchema }) body: z.infer<typeof profileSchema>,
  ) {
    // The account is the person's, in every tenant: an administrator acting
    // as them in one tenant doesn't change it (docs/tenancy.md).
    notWhileImpersonating(user);
    const changes = {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.timezone !== undefined && { timezone: body.timezone }),
      ...(body.locale !== undefined && {
        locale:
          body.locale === null ? null : this.supportedLocale(body.locale, true),
      }),
    };
    const updated = await this.account.updateProfile(user.id, changes);
    if (changes.locale) {
      // Answer in the new language right away.
      this.i18nContext.setLocale(changes.locale);
    }
    const {
      active: _a,
      hasPassword: _p,
      createdAt: _c,
      updatedAt: _u,
      ...principal
    } = updated!;
    return { ...principal, tenantId: user.tenantId };
  }

  /** Back to the administrator's own session, from an impersonation. */
  @SessionOnly()
  @Can.Anyone()
  @Post('impersonation/stop')
  @HttpCode(204)
  @ApiCookieAuth('user-session')
  @ApiOperation({ summary: 'Stop acting as another user' })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'Not impersonating anyone.' })
  async stopImpersonating(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: SessionRecord,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
  ) {
    const { cookie } = await this.impersonation.stop(user, session, ip);
    res.append('Set-Cookie', cookie);
  }

  /**
   * `locale` as a supported one (`ar-AE` stays a region of its own, `de-DE`
   * becomes `de`), or null; with `strict`, an unsupported one is a 400.
   */
  private supportedLocale(locale: string | undefined, strict = false) {
    if (!locale) {
      return null;
    }
    const supported = this.i18n.matchLocale(locale);
    if (!supported && strict) {
      throw new BadRequestException(t('auth.unsupportedLocale'));
    }
    return supported ?? null;
  }
}
