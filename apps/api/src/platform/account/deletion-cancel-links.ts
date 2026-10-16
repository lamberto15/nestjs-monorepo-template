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

/** The audience and `typ` of a cancel link's token: nothing else accepts one, and it is accepted nowhere else. */
const AUDIENCE = 'account-deletion-cancel';
const TYPE = 'deletion-cancel+jwt';
/** The HKDF label that makes the link key from JWT_SECRET: another key than the access tokens'. */
const KEY_LABEL = 'nestjs-monorepo-template/account-deletion-cancel/v1';
/** How long after the scheduled date a link still works: the job runs nightly, until then the deletion is pending. */
const AFTER_SCHEDULED_MS = 86_400_000;

/** What a valid cancel token names: one deletion request of one user. */
export interface DeletionCancelClaims {
  userId: string;
  deletionId: string;
}

/**
 * The tokens of the "cancel the deletion" link in the deletion mail: a JWT
 * signed with a key of its own (HKDF of JWT_SECRET, labelled: an access
 * token's key never verifies one, nor this key an access token), its own
 * audience and `typ`, naming the user (`sub`) and the deletion request
 * (`did`), expiring a day after the scheduled date. Single use comes from
 * the request it names: the route cancels only a pending one (not
 * cancelled, not carried out), so a second use, a link from an earlier
 * request, or one after the deletion ran finds nothing to cancel.
 *
 * @nestjs/authentication's JwtSigner and JwtVerifier do the signing and
 * the checks (signature, `exp`, `iss`, `aud`, `typ`, algorithm); the
 * package's email tokens (EmailTokenStore) have fixed purposes, reset and
 * verification, so a cancel link can't be one of them.
 */
export class DeletionCancelLinks {
  private readonly signer: JwtSigner;
  private readonly verifier: JwtVerifier;

  constructor(
    secret: string,
    issuer: string,
    private readonly now: () => number = Date.now,
  ) {
    const key = Buffer.from(
      hkdfSync('sha256', secret, Buffer.alloc(0), KEY_LABEL, 32),
    );
    const common = { key, issuer, audience: AUDIENCE, type: TYPE, now };
    this.signer = new JwtSigner(common);
    this.verifier = new JwtVerifier({
      ...common,
      algorithms: ['HS256'],
      required: ['exp', 'sub', 'did'],
    });
  }

  /** The token for a deletion request's mail. */
  sign(deletion: { id: string; userId: string; scheduledFor: Date }) {
    const ttl = Math.max(
      deletion.scheduledFor.getTime() - this.now() + AFTER_SCHEDULED_MS,
      60_000,
    );
    return this.signer.sign(
      { sub: deletion.userId, did: deletion.id },
      { ttl },
    );
  }

  /** What a token names, or null: badly signed, expired, another kind of token, malformed. */
  async verify(token: string): Promise<DeletionCancelClaims | null> {
    try {
      const claims = await this.verifier.verify(token);
      return typeof claims.sub === 'string' && typeof claims.did === 'string'
        ? { userId: claims.sub, deletionId: claims.did }
        : null;
    } catch {
      return null;
    }
  }
}

/**
 * DeletionCancelLinks on JWT_SECRET (the variable, else the one kept in
 * `app_secrets`, as IamModule reads it for the access tokens), issued by
 * APP_URL.
 */
export const deletionCancelLinksProvider: Provider = {
  provide: DeletionCancelLinks,
  inject: [getDrizzleToken(), ConfigService],
  useFactory: async (db: Database, config: ConfigService<CoreEnv, true>) =>
    new DeletionCancelLinks(
      await loadOrCreateSecret(db, 'JWT_SECRET', () =>
        randomBytes(32).toString('base64url'),
      ),
      config.get('APP_URL', { infer: true }),
    ),
};
