import { hkdfSync, randomBytes } from 'node:crypto';
import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getDrizzleToken } from '@nestjs/drizzle';
import { JwtSigner, JwtVerifier } from '@nestjs/authentication';
import type { CoreEnv } from '../../core/config/core.env.js';
import {
  type Database,
  loadOrCreateSecret,
} from '../../core/database/drizzle.js';
import type { DigestMode } from './notification.types.js';

/** The audience and `typ` of an unsubscribe token: nothing else accepts one, and it is accepted nowhere else. */
const AUDIENCE = 'notification-unsubscribe';
const TYPE = 'notification-unsubscribe+jwt';
/** The HKDF label that makes the link key from JWT_SECRET: another key than the access tokens' or the cancel links'. */
const KEY_LABEL = 'nestjs-monorepo-template/notification-unsubscribe/v1';
/**
 * How long a link works. A mail is read (and a mail client's unsubscribe
 * button pressed) long after it was sent; a year is the longest a notification
 * mail is still likely to be answered, and turning a mail off is harmless.
 */
const TTL_MS = 365 * 86_400_000;

/** The path of the one-click endpoint, under the API's version prefix. */
export const UNSUBSCRIBE_PATH = '/v1/notifications/unsubscribe';

/**
 * What a valid token names: one user, and what to turn off. `type`: a mail
 * about one notification type; `digests`: a digest mail, which stands for
 * every type the user receives in those modes.
 */
export type UnsubscribeClaims =
  | { userId: string; type: string; digests?: undefined }
  | { userId: string; type?: undefined; digests: DigestMode[] };

/**
 * The tokens of the unsubscribe links in notification mail (RFC 8058): a JWT
 * signed with a key of its own (HKDF of JWT_SECRET, labelled), its own
 * audience and `typ`, so it can be neither forged nor taken for another kind
 * of token. It names the user (`sub`) and what to switch off (`nt`, a
 * notification type, or `dg`, the digest modes). The link works without a
 * sign-in and repeatedly (switching a mail off twice is no different from once).
 *
 * @nestjs/authentication's JwtSigner and JwtVerifier do the signing and the
 * checks (signature, `exp`, `iss`, `aud`, `typ`, algorithm).
 */
export class NotificationUnsubscribeLinks {
  private readonly signer: JwtSigner;
  private readonly verifier: JwtVerifier;

  constructor(
    secret: string,
    private readonly issuer: string,
    now: () => number = Date.now,
  ) {
    const key = Buffer.from(
      hkdfSync('sha256', secret, Buffer.alloc(0), KEY_LABEL, 32),
    );
    const common = { key, issuer, audience: AUDIENCE, type: TYPE, now };
    this.signer = new JwtSigner(common);
    this.verifier = new JwtVerifier({
      ...common,
      algorithms: ['HS256'],
      required: ['exp', 'sub'],
    });
  }

  /** The token for a mail about one notification type. */
  signType(userId: string, type: string) {
    return this.signer.sign({ sub: userId, nt: type }, { ttl: TTL_MS });
  }

  /** The token for a digest mail that lists notifications of these modes. */
  signDigests(userId: string, modes: readonly DigestMode[]) {
    return this.signer.sign(
      { sub: userId, dg: [...new Set(modes)] },
      { ttl: TTL_MS },
    );
  }

  /** What a token names, or null: badly signed, expired, another kind of token, malformed. */
  async verify(token: string): Promise<UnsubscribeClaims | null> {
    try {
      const claims = await this.verifier.verify(token);
      if (typeof claims.sub !== 'string') return null;
      if (typeof claims.nt === 'string') {
        return { userId: claims.sub, type: claims.nt };
      }
      if (
        Array.isArray(claims.dg) &&
        claims.dg.length > 0 &&
        claims.dg.every((mode) => mode === 'hourly' || mode === 'daily')
      ) {
        return { userId: claims.sub, digests: claims.dg as DigestMode[] };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** The https URL a mail client POSTs to (the issuer is APP_URL). */
  url(token: string) {
    return `${this.issuer}${UNSUBSCRIBE_PATH}/${token}`;
  }
}

/**
 * The headers that make a mail one-click unsubscribable (RFC 8058): an https
 * `List-Unsubscribe` URL (plus a `mailto:` where the deployment handles
 * one) and `List-Unsubscribe-Post`. Nothing when the URL is not https: the
 * RFC requires it, and a mail client would ignore the pair. The headers
 * are DKIM-signed by whoever signs the mail (docs/deliverability.md).
 */
export function unsubscribeHeaders(
  url: string,
  mailto?: string,
): Record<string, string> {
  if (!url.startsWith('https://')) return {};
  return {
    'List-Unsubscribe': [
      `<${url}>`,
      ...(mailto ? [`<mailto:${mailto}>`] : []),
    ].join(', '),
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/**
 * NotificationUnsubscribeLinks on JWT_SECRET (the variable, else the one
 * kept in `app_secrets`, as IamModule reads it), issued by APP_URL.
 */
export const notificationUnsubscribeLinksProvider: Provider = {
  provide: NotificationUnsubscribeLinks,
  inject: [getDrizzleToken(), ConfigService],
  useFactory: async (db: Database, config: ConfigService<CoreEnv, true>) =>
    new NotificationUnsubscribeLinks(
      await loadOrCreateSecret(db, 'JWT_SECRET', () =>
        randomBytes(32).toString('base64url'),
      ),
      config.get('APP_URL', { infer: true }),
    ),
};
