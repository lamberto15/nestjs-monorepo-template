import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  type IssuedSession,
  SessionService,
  SignInService,
  TokenService,
} from '@nestjs/authentication';
import { ConfigService } from '@nestjs/config';
import { getDrizzleToken } from '@nestjs/drizzle';
import { t } from '@nestjs/i18n';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { decodeClientDataJSON } from '@simplewebauthn/server/helpers';
import { and, asc, count, eq, lt } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { CoreEnv } from '../../core/config/core.env.js';
import {
  type Database,
  loadOrCreateSecret,
} from '../../core/database/drizzle.js';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { REDIS } from '../../core/redis/redis.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../audit/audit.service.js';
import { signInOptions, tokenClaims } from '../auth/authentication-method.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';
import type { IamEnv } from '../iam.env.js';
import { passkeys, users } from '../iam.tables.js';
import { verifiedEmailOnly } from './account.schemas.js';
import type { PasskeyView } from './passkey.schemas.js';
import { type PasskeySettings, passkeySettingsOf } from './passkeys.config.js';
import { SecurityAlertsService } from './security-alerts.service.js';
import { assertNotLastSignInMethod } from './sign-in-methods.js';

/** How many passkeys one account may hold (each one is listed in every ceremony). */
export const MAX_PASSKEYS = 20;

/** What a challenge was made for; a response for one purpose can't finish another. */
export type CeremonyPurpose = 'registration' | 'sign-in' | 'reauthentication';

/**
 * What the request that finishes a ceremony must match: the user and the
 * session the challenge was made for, and the browser origin that asked
 * for it (its `Origin` header, when it sent one).
 */
export interface CeremonyBinding {
  /** The signed-in user; a sign-in has none yet. */
  userId?: string;
  /** The cookie session's id; null for a token client (nothing to bind to but the user). */
  sessionId?: string | null;
  /** The request's `Origin` header. */
  origin?: string | undefined;
}

/** What the challenge of a ceremony remembers (Redis, one-time). */
interface StoredChallenge {
  purpose: CeremonyPurpose;
  userId: string | null;
  sessionId: string | null;
  origin: string | null;
}

export type PasskeyRefusal =
  | 'client-data'
  | 'challenge'
  | 'session'
  | 'user'
  | 'origin'
  | 'unknown'
  | 'inactive'
  | 'counter'
  | 'user-verification'
  | 'invalid';

/** An assertion that doesn't hold: the caller decides what the client learns (401 at sign-in, 403 at re-authentication). */
export class PasskeyAssertionError extends Error {
  constructor(
    readonly reason: PasskeyRefusal,
    cause?: unknown,
  ) {
    super(`passkey assertion refused: ${reason}`, { cause });
  }
}

/** The request a sign-in comes from, for the audit entry and the new-device alert. */
export interface SignInContext {
  ip: string;
  userAgent: string | undefined;
  origin: string | undefined;
}

/** A verified assertion: whose, which passkey, and whether the authenticator verified its user (`uv`). */
export interface VerifiedAssertion {
  user: UserPrincipal;
  passkey: Row;
  userVerified: boolean;
}

type Row = typeof passkeys.$inferSelect;

/**
 * The key of the decoy credentials (`signInOptions()` for an address with
 * no passkeys): derived from JWT_SECRET with HKDF, so it is stable across
 * restarts and instances without another secret to configure. Custom: no
 * package makes decoys; HKDF keeps the two uses of the secret apart.
 */
export const PASSKEY_DECOY_KEY = Symbol('PASSKEY_DECOY_KEY');

export const passkeyDecoyKeyProvider = {
  provide: PASSKEY_DECOY_KEY,
  inject: [getDrizzleToken()],
  useFactory: async (db: Database) =>
    Buffer.from(
      hkdfSync(
        'sha256',
        await loadOrCreateSecret(db, 'JWT_SECRET', () =>
          randomBytes(32).toString('base64url'),
        ),
        Buffer.alloc(0),
        'passkey-decoy-credentials',
        32,
      ),
    ),
};

/** A user's WebAuthn user handle: their id's 16 bytes (stable, no personal data in it). */
export const userHandleOf = (userId: string) =>
  Uint8Array.from(Buffer.from(userId.replace(/-/g, ''), 'hex'));

const toBase64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('base64url');
const fromBase64url = (text: string) =>
  Uint8Array.from(Buffer.from(text, 'base64url'));

/**
 * Passkeys (WebAuthn, @simplewebauthn/server): several named credentials
 * per user, registered from a recent session; a sign-in with one, by email
 * or usernameless (discoverable credentials); and the same assertion as a
 * re-authentication (ReauthenticationService). docs/auth.md, "Passkeys".
 *
 * - **Challenges** live in Redis for PASSKEY_CHALLENGE_TTL_SECONDS and are
 *   taken with GETDEL: each works once, on every instance alike. Each
 *   remembers its purpose, the user and session it was made for and the
 *   browser origin that asked (`CeremonyBinding`): a response finishing
 *   another ceremony, another user's, from another origin, is refused.
 * - **The relying party** (`PasskeySettings`: RP ID, origins) is
 *   configuration; the library checks the response's origin and RP ID hash
 *   against it, the signature against the stored public key, and the
 *   counter: a lower one than seen before (synced passkeys keep 0) means a
 *   cloned authenticator, and the assertion is refused.
 * - **User verification** (`uv`): asked for (`required`) in every ceremony
 *   and required to register and to re-authenticate; at sign-in, a response
 *   with it counts for both factors (a pending second factor is completed
 *   in place), one without it for the first alone.
 *
 * Custom: @nestjs/authentication 0.1.1 has no WebAuthn (re-checked at
 * build time); it does the session (SignInService: fixation defence,
 * login CSRF, the cookie) and the tokens, this service the ceremonies.
 */
@Injectable()
export class PasskeysService {
  private readonly logger = new Logger('Passkeys');
  readonly settings: PasskeySettings;

  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PASSKEY_DECOY_KEY) private readonly decoyKey: Buffer,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly securityAlerts: SecurityAlertsService,
    private readonly signInService: SignInService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly tenancy: Tenancy,
    config: ConfigService<IamEnv & CoreEnv, true>,
  ) {
    this.settings = passkeySettingsOf(config);
  }

  get enabled() {
    return this.settings.enabled;
  }

  /** 404 when PASSKEYS=off: the routes don't exist for this deployment. */
  assertEnabled() {
    if (!this.enabled) {
      throw new NotFoundException(t('auth.passkeysOff'));
    }
  }

  /** The user's passkeys, oldest first. */
  async list(userId: string): Promise<PasskeyView[]> {
    const rows = await this.db
      .select()
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .orderBy(asc(passkeys.createdAt), asc(passkeys.id));
    return rows.map(toView);
  }

  /** Whether the user has a passkey (re-authentication's options). */
  async has(userId: string) {
    const [found] = await this.db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .limit(1);
    return found !== undefined;
  }

  // Registration

  /**
   * Options for `navigator.credentials.create()`: a challenge bound to the
   * user and their session, the user's handle, the credentials they have
   * (so the authenticator refuses to register one twice), user
   * verification required, no attestation (the authenticator's model is
   * nobody's business here; `none` also never prompts for consent).
   */
  async registrationOptions(
    user: UserPrincipal,
    binding: CeremonyBinding,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    this.assertEnabled();
    // Verify first: a passkey is a way in, as a second factor or a provider is.
    verifiedEmailOnly(user);
    const existing = await this.descriptors(user.id);
    if (existing.length >= MAX_PASSKEYS) {
      throw tooMany();
    }
    const options = await generateRegistrationOptions({
      rpName: this.settings.rpName,
      rpID: this.settings.rpId,
      userName: user.email,
      userDisplayName: user.name,
      userID: userHandleOf(user.id),
      timeout: this.settings.challengeTtlSeconds * 1000,
      attestationType: 'none',
      excludeCredentials: existing,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });
    await this.storeChallenge(options.challenge, {
      purpose: 'registration',
      userId: user.id,
      sessionId: binding.sessionId ?? null,
      origin: binding.origin ?? null,
    });
    return options;
  }

  /**
   * Verifies the authenticator's answer and keeps the credential: the row,
   * its audit entry and the owner's notification in one transaction. 400
   * `passkey_invalid` (with `reason`) for anything that doesn't hold:
   * the user is on their own account, so saying why helps and leaks nothing.
   */
  async register(
    user: UserPrincipal,
    response: RegistrationResponseJSON,
    name: string,
    binding: CeremonyBinding,
    ip: string,
  ): Promise<PasskeyView> {
    this.assertEnabled();
    verifiedEmailOnly(user);
    const refused = (reason: string, cause?: unknown) => {
      this.logger.debug(`registration refused: ${reason}`, {
        cause: cause instanceof Error ? cause.message : undefined,
      });
      return new BadRequestException({
        code: 'passkey_invalid',
        message: t('auth.passkeyRegistrationFailed'),
        reason,
      });
    };
    let challenge: string;
    let stored: StoredChallenge;
    try {
      ({ challenge, stored } = await this.takeChallenge(
        response.response.clientDataJSON,
        'registration',
        { ...binding, userId: user.id },
      ));
    } catch (error) {
      if (error instanceof PasskeyAssertionError) {
        throw refused(error.reason, error.cause);
      }
      throw error;
    }
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.expectedOrigin(stored),
        expectedRPID: this.settings.rpId,
        // A passkey must be able to verify its user, or it could never be a second factor.
        requireUserVerification: true,
      });
    } catch (error) {
      throw refused(
        /user verification/i.test((error as Error).message)
          ? 'user-verification'
          : /origin/i.test((error as Error).message)
            ? 'origin'
            : 'invalid',
        error,
      );
    }
    if (!verification.verified) {
      throw refused('invalid');
    }
    const { credential, credentialDeviceType, credentialBackedUp, aaguid } =
      verification.registrationInfo;
    const row = await this.accountLevel(async (tx) => {
      // The account row locked: two registrations at once count one after the other.
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, user.id))
        .for('update');
      const [{ held }] = await tx
        .select({ held: count() })
        .from(passkeys)
        .where(eq(passkeys.userId, user.id));
      if (held >= MAX_PASSKEYS) {
        throw tooMany();
      }
      const [inserted] = await tx
        .insert(passkeys)
        .values({
          userId: user.id,
          name,
          credentialId: credential.id,
          publicKey: toBase64url(credential.publicKey),
          counter: credential.counter,
          // Sorted, as browsers report them (and as the decoys are).
          transports: [...(credential.transports ?? [])].sort(),
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          aaguid,
        })
        .onConflictDoNothing({ target: passkeys.credentialId })
        .returning();
      if (!inserted) {
        // Registered already, here or on another account: the authenticator's id is global.
        throw new ConflictException({
          code: 'passkey_registered',
          message: t('auth.passkeyRegistered'),
        });
      }
      await this.securityAlerts.credentialsChanged(tx, user, user.id, {
        action: 'auth.passkey-added',
        ip,
        type: 'security.passkeyAdded',
        data: { name },
        details: {
          passkey: inserted.id,
          name,
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
        },
      });
      return inserted;
    });
    this.securityAlerts.deliverNow();
    return toView(row);
  }

  /** A new name; 404 for another user's passkey. Audited. */
  async rename(user: UserPrincipal, id: string, name: string) {
    return this.accountLevel(async (tx) => {
      const [row] = await tx
        .update(passkeys)
        .set({ name })
        .where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)))
        .returning();
      if (!row) {
        throw new NotFoundException();
      }
      await this.audit.record(
        user,
        {
          action: 'auth.passkey-renamed',
          targetType: 'user',
          targetId: user.id,
          details: { passkey: row.id, name },
        },
        tx,
      );
      return toView(row);
    });
  }

  /**
   * Removes a passkey, unless it is the account's last way to sign in (409
   * `last_sign_in_method`, counted under the account's row lock). Its
   * audit entry and the owner's notification go in the same transaction.
   */
  async remove(user: UserPrincipal, id: string, ip: string) {
    await this.accountLevel(async (tx) => {
      const [found] = await tx
        .select({ id: passkeys.id, name: passkeys.name })
        .from(passkeys)
        .where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)));
      if (!found) {
        throw new NotFoundException();
      }
      await assertNotLastSignInMethod(tx, user.id);
      const deleted = await tx
        .delete(passkeys)
        .where(eq(passkeys.id, found.id))
        .returning({ id: passkeys.id });
      if (deleted.length === 0) {
        throw new NotFoundException(); // removed meanwhile
      }
      await this.securityAlerts.credentialsChanged(tx, user, user.id, {
        action: 'auth.passkey-removed',
        ip,
        type: 'security.passkeyRemoved',
        data: { name: found.name },
        details: { passkey: found.id, name: found.name },
      });
    });
    this.securityAlerts.deliverNow();
  }

  // Sign-in

  /**
   * Options for `navigator.credentials.get()`. Without an email, the
   * browser offers the site's discoverable credentials, and the challenge
   * is bound to nobody until the credential says whose it is. With one,
   * the account's credentials are listed (`allowCredentials`) and the
   * challenge is bound to the account; an address without an account or
   * without passkeys gets decoy credentials instead (`decoys()`: derived
   * from the address, so the same every time, and shaped like real ones),
   * after the same queries: the answer looks alike whether or not the
   * address has an account or passkeys, as the password sign-in's does.
   */
  async signInOptions(
    email: string | undefined,
    binding: Pick<CeremonyBinding, 'origin'>,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    this.assertEnabled();
    let userId: string | null = null;
    let allowCredentials: { id: string; transports?: string[] }[] = [];
    if (email !== undefined) {
      const found = await this.users.findActiveByEmail(email);
      // The same queries either way (no account: an id nobody has), so the time tells nothing.
      allowCredentials = await this.descriptors(found?.user.id ?? NOBODY);
      if (found && allowCredentials.length > 0) {
        userId = found.user.id;
      } else {
        allowCredentials = this.decoys(email);
      }
    }
    return this.requestOptions(
      {
        purpose: 'sign-in',
        userId,
        sessionId: null,
        origin: binding.origin ?? null,
      },
      allowCredentials,
    );
  }

  /** Options for re-authenticating in place: the signed-in user's credentials, bound to their session. */
  async reauthenticationOptions(user: UserPrincipal, binding: CeremonyBinding) {
    this.assertEnabled();
    const allowCredentials = await this.descriptors(user.id);
    if (allowCredentials.length === 0) {
      throw new ConflictException({
        code: 'reauthentication_unavailable',
        message: t('auth.noPasskeys'),
      });
    }
    return this.requestOptions(
      {
        purpose: 'reauthentication',
        userId: user.id,
        sessionId: binding.sessionId ?? null,
        origin: binding.origin ?? null,
      },
      allowCredentials,
    );
  }

  /**
   * A browser's sign-in with a passkey: the assertion is verified (401 for
   * anything that doesn't hold, audited as a failed sign-in, with nothing
   * said about why), the session is made by the package as for a password
   * (`signInOptions('passkey')`: the method lands in its metadata), and a
   * verified user (`uv`) completes a pending second factor in place: the
   * session is rotated to `mfa: verified` with `authenticatedAt` now, and
   * the new cookie is returned for the route to set. Audited, and the user
   * told of a new device, as any sign-in.
   */
  async signIn(
    response: AuthenticationResponseJSON,
    context: SignInContext,
  ): Promise<{ signedIn: boolean; mfaRequired: boolean; cookie?: string }> {
    this.assertEnabled();
    const { user, passkey, userVerified } = await this.assertOrRefuse(
      response,
      { origin: context.origin },
      context.ip,
    );
    assertVerified(user);
    let issued: IssuedSession = await this.signInService.signIn(
      user.id,
      signInOptions('passkey'),
    );
    let cookie: string | undefined;
    if (issued.session.mfa === 'pending' && userVerified) {
      // The authenticator verified its user: both factors are done. The
      // rotation keeps the sign-in's metadata; the sign-in completed now.
      const verified = await this.sessions.rotate(issued.session, {
        mfa: 'verified',
        metadata: {
          ...issued.session.metadata,
          authenticatedAt: new Date().toISOString(),
        },
      });
      if (verified) {
        issued = verified;
        cookie = verified.cookie;
      }
    }
    await this.securityAlerts.signedIn(user, {
      ip: context.ip,
      userAgent: context.userAgent,
      method: 'passkey',
      details: { passkey: passkey.id, userVerified },
    });
    const mfaRequired = issued.session.mfa === 'pending';
    return { signedIn: !mfaRequired, mfaRequired, cookie };
  }

  /**
   * A token client's sign-in with a passkey (native apps). The tokens
   * record the method as RFC 8176's `pop` (proof of possession of a key;
   * `hwk` would be dropped by the package, which keeps the values meaning
   * a second factor for itself), read back by `authenticationOf()`. With
   * two-factor on, the package's `issue()` still wants a code: it has no
   * way to take a verified passkey as the second factor, so `secondFactor`
   * goes with the assertion (docs/auth.md, "Passkeys").
   */
  async issueTokens(
    response: AuthenticationResponseJSON,
    secondFactor: { code?: string; recoveryCode?: string },
    context: SignInContext,
    tenantId?: string,
  ) {
    this.assertEnabled();
    const { user, passkey, userVerified } = await this.assertOrRefuse(
      response,
      { origin: context.origin },
      context.ip,
    );
    assertVerified(user);
    // As the password's token sign-in (AccountService.issueTokens): the
    // tenant asked for when the user is a member (else the same 401 as a
    // refused assertion: nothing about tenants is told before a sign-in),
    // else the last chosen; none for a user without a tenant.
    const tenant =
      tenantId === undefined
        ? await this.users.defaultTenant(user.id)
        : (await this.users.isMember(user.id, tenantId))
          ? tenantId
          : null;
    if (tenantId !== undefined && !tenant) {
      throw new UnauthorizedException(t('auth.passkeyInvalid'));
    }
    const tokens = await this.tokens.issue(user.id, {
      method: 'passkey',
      claims: tokenClaims(['pop'], new Date(), tenant),
      secondFactor,
    });
    await this.securityAlerts.signedIn(user, {
      ip: context.ip,
      userAgent: context.userAgent,
      method: 'passkey',
      via: 'token',
      details: { passkey: passkey.id, userVerified },
    });
    return tokens;
  }

  /**
   * An assertion by the signed-in user, for a re-authentication: the
   * challenge must be one made for them and their session
   * (`reauthenticationOptions`), and the authenticator must have verified
   * its user. Throws `PasskeyAssertionError`; the caller audits and answers.
   */
  async assertForUser(
    user: UserPrincipal,
    response: AuthenticationResponseJSON,
    binding: CeremonyBinding,
  ) {
    this.assertEnabled();
    const verified = await this.verifyAssertion(response, 'reauthentication', {
      ...binding,
      userId: user.id,
    });
    if (!verified.userVerified) {
      throw new PasskeyAssertionError('user-verification');
    }
    return verified;
  }

  /** `verifyAssertion()` for a sign-in: a refusal is audited as a failed sign-in and answered 401, reason untold. */
  private async assertOrRefuse(
    response: AuthenticationResponseJSON,
    binding: CeremonyBinding,
    ip: string,
  ) {
    try {
      return await this.verifyAssertion(response, 'sign-in', binding);
    } catch (error) {
      if (!(error instanceof PasskeyAssertionError)) {
        throw error;
      }
      await this.audit.recordAnonymous('passkey', {
        action: 'auth.sign-in-failed',
        ip,
        details: {
          method: 'passkey',
          reason: error.reason,
          credentialId: response.id.slice(0, 16),
        },
      });
      throw new UnauthorizedException(t('auth.passkeyInvalid'));
    }
  }

  /**
   * The assertion against the challenge it answers, the credential it
   * names and that credential's owner: the challenge once (GETDEL) and for
   * this purpose, user, session and origin; the credential known, its
   * owner the one the challenge was for (when it was for someone) and the
   * one the authenticator's user handle names; the owner active; then the
   * library's checks (origin, RP ID, flags, signature, counter). The
   * counter and last use are recorded, only forwards (a compare-and-set:
   * two assertions at once can't move it back).
   */
  private async verifyAssertion(
    response: AuthenticationResponseJSON,
    purpose: CeremonyPurpose,
    binding: CeremonyBinding,
  ): Promise<VerifiedAssertion> {
    const { challenge, stored } = await this.takeChallenge(
      response.response.clientDataJSON,
      purpose,
      binding,
    );
    const [row] = await this.db
      .select()
      .from(passkeys)
      .where(eq(passkeys.credentialId, response.id));
    if (!row) {
      throw new PasskeyAssertionError('unknown');
    }
    if (stored.userId && stored.userId !== row.userId) {
      throw new PasskeyAssertionError('user');
    }
    if (
      response.response.userHandle !== undefined &&
      response.response.userHandle !== toBase64url(userHandleOf(row.userId))
    ) {
      throw new PasskeyAssertionError('user');
    }
    const user = await this.users.findActive(row.userId);
    if (!user) {
      throw new PasskeyAssertionError('inactive');
    }
    const verify = (counter: number) =>
      verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.expectedOrigin(stored),
        expectedRPID: this.settings.rpId,
        credential: {
          id: row.credentialId,
          publicKey: fromBase64url(row.publicKey),
          counter,
          transports: row.transports,
        },
        // Read from the response instead: without it, the first factor alone.
        requireUserVerification: false,
      });
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verify(row.counter);
    } catch (error) {
      const message = (error as Error).message ?? '';
      if (/counter value/i.test(message)) {
        throw await this.counterRegression(row, () => verify(0), error);
      }
      throw new PasskeyAssertionError(
        /origin/i.test(message) ? 'origin' : 'invalid',
        error,
      );
    }
    if (!verification.verified) {
      throw new PasskeyAssertionError('invalid');
    }
    const { newCounter, userVerified, credentialBackedUp } =
      verification.authenticationInfo;
    const [recorded] = await this.db
      .update(passkeys)
      .set({
        counter: newCounter,
        backedUp: credentialBackedUp,
        lastUsedAt: new Date(),
      })
      .where(
        and(
          eq(passkeys.id, row.id),
          // Synced passkeys keep 0; any other must have moved forwards.
          newCounter === 0
            ? eq(passkeys.counter, 0)
            : lt(passkeys.counter, newCounter),
        ),
      )
      .returning({ id: passkeys.id });
    if (!recorded) {
      // Another assertion recorded a counter as high meanwhile (or the
      // passkey was removed): this one is a replay of the counter.
      throw new PasskeyAssertionError('counter');
    }
    return { user, passkey: row, userVerified };
  }

  /**
   * The library refused the counter (lower than or equal to the one seen,
   * not both 0). It checks the counter before the signature, so the
   * signature is checked on its own first: only a signed response is a
   * cloned authenticator (or one restored from a backup), logged as a
   * warning; an unsigned one is just invalid. Either way it is refused;
   * the owner removes the passkey and registers it again.
   */
  private async counterRegression(
    row: Row,
    verifySignature: () => Promise<{ verified: boolean }>,
    cause: unknown,
  ) {
    const signed = await verifySignature().then(
      (result) => result.verified,
      () => false,
    );
    if (!signed) {
      return new PasskeyAssertionError('invalid', cause);
    }
    this.logger.warn('passkey counter regression: a cloned authenticator?', {
      passkey: row.id,
      user: row.userId,
    });
    return new PasskeyAssertionError('counter', cause);
  }

  /**
   * A transaction outside any tenant: passkeys are the person's, not a
   * tenant's (docs/tenancy.md), so their audit entries and the owner's
   * notifications are account-level, like a sign-in's, whichever tenant
   * the session is in.
   */
  private accountLevel<T>(work: (tx: Transaction) => Promise<T>) {
    return this.tenancy.none(() => inTransaction(this.txHost, work));
  }

  // Challenges

  private async requestOptions(
    stored: StoredChallenge,
    allowCredentials: { id: string; transports?: string[] }[],
  ) {
    const options = await generateAuthenticationOptions({
      rpID: this.settings.rpId,
      timeout: this.settings.challengeTtlSeconds * 1000,
      userVerification: 'required',
      // Empty: left out, so the browser offers discoverable credentials.
      ...(allowCredentials.length > 0 && {
        allowCredentials: allowCredentials as {
          id: string;
          transports?: AuthenticatorTransportFuture[];
        }[],
      }),
    });
    await this.storeChallenge(options.challenge, stored);
    return options;
  }

  /**
   * The origins the response's `clientDataJSON.origin` may name: the one
   * that asked for the challenge, when it is a configured one; else any
   * configured one. An `Origin` header is the client's to set, so it narrows
   * the configured list and never widens it.
   */
  private expectedOrigin(stored: StoredChallenge): string | string[] {
    return stored.origin && this.settings.origins.includes(stored.origin)
      ? stored.origin
      : this.settings.origins;
  }

  private key(purpose: CeremonyPurpose, challenge: string) {
    return `passkey:challenge:${purpose}:${challenge}`;
  }

  /** Keeps a challenge for its TTL; one a client already holds is never replaced (NX). */
  private async storeChallenge(challenge: string, stored: StoredChallenge) {
    const kept = await this.redis.set(
      this.key(stored.purpose, challenge),
      JSON.stringify(stored),
      'EX',
      this.settings.challengeTtlSeconds,
      'NX',
    );
    if (kept !== 'OK') {
      throw new Error('A passkey challenge was issued twice'); // 256 random bits: never
    }
  }

  /**
   * The challenge the response answers, taken from the store (GETDEL: a
   * second response to it finds nothing), and what it was bound to,
   * checked against the request that finishes the ceremony: the session
   * (when the ceremony started from one), the user (when it was for one)
   * and the origin (when the browser named one).
   */
  private async takeChallenge(
    clientDataJSON: string,
    purpose: CeremonyPurpose,
    binding: CeremonyBinding,
  ): Promise<{ challenge: string; stored: StoredChallenge }> {
    let challenge: unknown;
    try {
      ({ challenge } = decodeClientDataJSON(clientDataJSON));
    } catch (error) {
      throw new PasskeyAssertionError('client-data', error);
    }
    if (
      typeof challenge !== 'string' ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(challenge)
    ) {
      throw new PasskeyAssertionError('client-data');
    }
    const raw = await this.redis.getdel(this.key(purpose, challenge));
    if (!raw) {
      throw new PasskeyAssertionError('challenge'); // unknown, used, or expired
    }
    const stored = JSON.parse(raw) as StoredChallenge;
    if (binding.userId !== undefined && stored.userId !== binding.userId) {
      throw new PasskeyAssertionError('user');
    }
    if (
      binding.sessionId !== undefined &&
      stored.sessionId !== binding.sessionId
    ) {
      throw new PasskeyAssertionError('session');
    }
    if (stored.origin !== null && binding.origin !== stored.origin) {
      throw new PasskeyAssertionError('origin');
    }
    return { challenge, stored };
  }

  /** The user's credentials as `allowCredentials` / `excludeCredentials` entries. */
  private async descriptors(userId: string) {
    const rows = await this.db
      .select({
        credentialId: passkeys.credentialId,
        transports: passkeys.transports,
      })
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .orderBy(asc(passkeys.createdAt));
    return rows.map((row) => ({
      id: row.credentialId,
      transports: row.transports as AuthenticatorTransportFuture[],
    }));
  }

  /**
   * Credentials nobody has, the same for an address every time (HMACs of
   * it): one or two, each with an id length and transports that real
   * authenticators have (16 bytes: Google Password Manager, 20: iCloud
   * Keychain, 32: Windows Hello, many security keys), transports in the
   * sorted order browsers report them. What still shows: an account with
   * three passkeys or more, or with unusual ids, is a real one.
   */
  private decoys(email: string) {
    const address = email.trim().normalize('NFC').toLowerCase();
    const mac = (label: string) =>
      createHmac('sha256', this.decoyKey)
        .update(`${label}:${address}`)
        .digest();
    const shape = mac('shape');
    return Array.from({ length: 1 + (shape[0] % 2) }, (_, i) => ({
      id: mac(`id${i}`)
        .subarray(0, DECOY_ID_LENGTHS[shape[1 + i] % DECOY_ID_LENGTHS.length])
        .toString('base64url'),
      transports: DECOY_TRANSPORTS[shape[3 + i] % DECOY_TRANSPORTS.length],
    }));
  }
}

type AuthenticatorTransportFuture = NonNullable<
  RegistrationResponseJSON['response']['transports']
>[number];

/** A user id nobody has: the descriptors' query for an address without an account. */
const NOBODY = '00000000-0000-0000-0000-000000000000';
const DECOY_ID_LENGTHS = [16, 20, 32];
const DECOY_TRANSPORTS: AuthenticatorTransportFuture[][] = [
  ['hybrid', 'internal'],
  ['internal'],
  ['hybrid', 'internal'],
  ['nfc', 'usb'],
];

/**
 * Verify first (docs/auth.md, "Sign-up"): an account whose address was never proved
 * (a self sign-up) signs in by no method; its password is refused the
 * same way (CredentialsService). Registration already wants a verified
 * address, so this holds even if one changed.
 */
function assertVerified(user: UserPrincipal) {
  if (!user.emailVerified) {
    throw new ForbiddenException({
      code: 'email_unverified',
      message: t('auth.emailUnverified'),
    });
  }
}

const tooMany = () =>
  new ConflictException({
    code: 'passkey_limit',
    message: t('auth.passkeyLimit', { args: { max: MAX_PASSKEYS } }),
  });

const toView = (row: Row): PasskeyView => ({
  id: row.id,
  name: row.name,
  deviceType: row.deviceType,
  backedUp: row.backedUp,
  transports: row.transports,
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
