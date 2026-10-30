import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';
import { REDIS } from '../../core/redis/redis.js';
import type { NativeIdentity } from '../auth/sign-in-context.js';

/** A native app's login under way in the system browser: where it ends, and the PKCE challenge its code is bound to. */
export interface NativeLogin {
  redirectUri: string;
  codeChallenge: string;
  /** A signed-in app's link or step-up (a ticket's), not a sign-in. */
  account?: NativeAccountFlow;
}

/**
 * A link or a step-up a signed-in app started (POST
 * /auth/identities/{provider}/native): for whom, from which token session
 * (its `sid`), through which provider, and since when (a step-up's
 * `auth_time` must not be older).
 */
export interface NativeAccountFlow {
  purpose: 'link' | 'reauthenticate';
  userId: string;
  sid: string;
  provider: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /** The tenant the session acts in: a step-up's new tokens keep it. */
  tenantId: string | null;
}

/** What a handoff code signs in: who, how, and what the exchange checks. */
export interface NativeHandoff {
  userId: string;
  /** The package's method string: `oidc:google`, `sso:<connection>`, `magic-link`. */
  method: string;
  codeChallenge: string;
  /** Epoch milliseconds, when the provider told when the user authenticated. */
  authenticatedAt?: number;
  /** The tenant the sign-in is for (a tenant's SSO connection): the tokens act there. */
  tenantId?: string;
  /** More for the sign-in's audit entry (the SSO connection). */
  details?: Record<string, unknown>;
  /** A link's or a step-up's code: only its session completes it, never a sign-in's exchange. */
  account?: Pick<
    NativeAccountFlow,
    'purpose' | 'sid' | 'provider' | 'tenantId'
  > & {
    /** A link's: the identity the callback judged, connected when the app completes it. */
    identity?: NativeIdentity;
  };
}

/** As long as the package keeps an OIDC login's transaction (`oidc.transactionTtl`, 10 minutes). */
const LOGIN_TTL_MS = 10 * 60_000;
/** RFC 6749 §4.1.2 recommends 10 minutes at most; the app exchanges it at once. */
const CODE_TTL_MS = 60_000;
/** The app opens the ticket's URL at once; the login it starts lives on. */
const TICKET_TTL_MS = 5 * 60_000;

/**
 * The native sign-ins under way (docs/auth.md, "Native and mobile apps"),
 * in Redis so the callback and the exchange may reach any replica: the
 * logins started with a native redirect URI, by the flow's own key (an
 * OIDC `state`, an SSO browser binding), and the one-time codes their
 * callbacks hand to the app, stored only as their SHA-256.
 */
@Injectable()
export class NativeHandoffs {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async startLogin(key: string, login: NativeLogin) {
    await this.redis.set(
      loginKey(key),
      JSON.stringify(login),
      'PX',
      LOGIN_TTL_MS,
    );
  }

  /**
   * The native login `key` names; undefined for a browser's. Read, not
   * taken: a callback that fails the flow's checks (someone else's request
   * with a state they learnt) leaves it for the browser that started it.
   */
  async login(key: unknown): Promise<NativeLogin | undefined> {
    if (!validKey(key)) {
      return undefined;
    }
    const value = await this.redis.get(loginKey(key));
    return value ? (JSON.parse(value) as NativeLogin) : undefined;
  }

  async forgetLogin(key: unknown) {
    if (validKey(key)) {
      await this.redis.del(loginKey(key));
    }
  }

  /** A new ticket for a signed-in app's link or step-up (256 random bits), stored only as its SHA-256. */
  async issueTicket(login: NativeLogin & { account: NativeAccountFlow }) {
    const ticket = randomBytes(32).toString('base64url');
    await this.redis.set(
      ticketKey(ticket),
      JSON.stringify(login),
      'PX',
      TICKET_TTL_MS,
    );
    return ticket;
  }

  /** Takes the ticket (once); undefined when unknown, used or expired. */
  async takeTicket(
    ticket: unknown,
  ): Promise<(NativeLogin & { account: NativeAccountFlow }) | undefined> {
    if (!validKey(ticket)) {
      return undefined;
    }
    const value = await this.redis.getdel(ticketKey(ticket));
    return value
      ? (JSON.parse(value) as NativeLogin & { account: NativeAccountFlow })
      : undefined;
  }

  /** A new one-time code for `handoff` (256 random bits). */
  async issueCode(handoff: NativeHandoff) {
    const code = randomBytes(32).toString('base64url');
    await this.redis.set(
      codeKey(code),
      JSON.stringify(handoff),
      'PX',
      CODE_TTL_MS,
    );
    return code;
  }

  /**
   * Takes the code (once: of two exchanges, one gets it), with its time
   * left; undefined when unknown, used or expired.
   */
  async takeCode(
    code: string,
  ): Promise<{ handoff: NativeHandoff; ttlMs: number } | undefined> {
    const key = codeKey(code);
    const [ttl, value] = ((await this.redis
      .multi()
      .pttl(key)
      .getdel(key)
      .exec()) ?? []) as [
      [Error | null, number],
      [Error | null, string | null],
    ];
    if (ttl?.[0] || value?.[0] || !value?.[1]) {
      return undefined;
    }
    return {
      handoff: JSON.parse(value[1]) as NativeHandoff,
      ttlMs: ttl[1],
    };
  }

  /** Puts a taken code back, for its time left (an exchange that only learnt a second factor is needed). */
  async restoreCode(code: string, handoff: NativeHandoff, ttlMs: number) {
    if (ttlMs > 0) {
      await this.redis.set(
        codeKey(code),
        JSON.stringify(handoff),
        'PX',
        ttlMs,
        'NX',
      );
    }
  }
}

function validKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 512;
}

const loginKey = (key: string) => `native:login:${key}`;
const hashed = (value: string) =>
  createHash('sha256').update(value).digest('base64url');
const codeKey = (code: string) => `native:code:${hashed(code)}`;
const ticketKey = (ticket: string) => `native:ticket:${hashed(ticket)}`;
