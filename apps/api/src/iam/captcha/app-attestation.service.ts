import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, lt } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { REDIS } from '../../core/redis/redis.js';
import type { IamEnv } from '../iam.env.js';
import { appAttestKeys } from '../iam.tables.js';
import {
  androidApp,
  AttestationRefused,
  verifyAppleAssertion,
  verifyAppleAttestation,
  verifyPlayIntegrity,
} from './app-attestation.js';

/** The header a native app's proof travels in, in place of `X-Captcha-Token`. */
export const ATTESTATION_HEADER = 'X-App-Attestation';

/** Long enough to get a verdict from Play or the Secure Enclave, and no longer. */
const CHALLENGE_TTL_SECONDS = 300;

/** The roots App Attest chains to (Apple's; a test's own). */
export const APP_ATTEST_ROOTS = Symbol('APP_ATTEST_ROOTS');

/**
 * App attestation (docs/auth.md, "App attestation"; APP_ATTESTATION): a
 * genuine build of a listed app passes the bot check without the widget.
 * The app asks for a one-time challenge, and binds its proof to it:
 *
 * - iOS (App Attest): an install registers its key once, with Apple's
 *   attestation (`registerAppleKey`); later, each guarded request carries
 *   an assertion by that key, over the challenge, counting up.
 * - Android (Play Integrity): each guarded request carries an integrity
 *   token whose nonce is the challenge, decrypted and verified here with
 *   the Play Console's keys (no call to Google).
 *
 * `X-App-Attestation`: `ios <challenge> <keyId> <assertion>` or
 * `android <challenge> <token>`, each base64url (the token as Play gives it).
 */
@Injectable()
export class AppAttestationService {
  constructor(
    private readonly config: ConfigService<IamEnv, true>,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_ATTEST_ROOTS) private readonly roots: string[],
  ) {}

  get enabled() {
    return this.config.get('APP_ATTESTATION', { infer: true });
  }

  /** A one-time challenge for one proof; 404 while off. */
  async challenge() {
    this.assertEnabled();
    const challenge = randomBytes(32).toString('base64url');
    await this.redis.set(
      challengeKey(challenge),
      '1',
      'EX',
      CHALLENGE_TTL_SECONDS,
    );
    return { challenge, expiresIn: CHALLENGE_TTL_SECONDS };
  }

  /**
   * Registers an install's App Attest key from its attestation, made over
   * `challenge` (its clientDataHash: the challenge's SHA-256). 403
   * `attestation_invalid` with the reason; 404 while off.
   */
  async registerAppleKey(input: {
    keyId: string;
    attestation: string;
    challenge: string;
  }) {
    this.assertEnabled();
    await this.refusing(async () => {
      await this.takeChallenge(input.challenge);
      const keyId = Buffer.from(input.keyId, 'base64url');
      const { appId, publicKey } = await verifyAppleAttestation({
        keyId,
        attestation: Buffer.from(input.attestation, 'base64url'),
        clientDataHash: clientDataHash(input.challenge),
        appIds: this.config.get('PASSKEY_APPLE_APPS', { infer: true }),
        development: this.config.get('APP_ATTEST_DEVELOPMENT', {
          infer: true,
        }),
        roots: this.roots,
      });
      const [stored] = await database(this.txHost)
        .insert(appAttestKeys)
        .values({
          keyId: keyId.toString('base64url'),
          appId,
          publicKey: publicKey.toString('base64url'),
        })
        .onConflictDoNothing()
        .returning({ id: appAttestKeys.id });
      if (!stored) {
        throw new AttestationRefused('key'); // attested before: once per key
      }
    });
  }

  /**
   * Passes when `header` proves a genuine build, else throws 403
   * `attestation_invalid`. The challenge is spent either way.
   */
  async verify(header: string) {
    await this.refusing(async () => {
      const [platform, challenge, ...rest] = header.split(' ');
      if (!challenge || (platform !== 'ios' && platform !== 'android')) {
        throw new AttestationRefused('malformed');
      }
      await this.takeChallenge(challenge);
      if (platform === 'ios' && rest.length === 2) {
        await this.verifyApple(challenge, rest[0]!, rest[1]!);
      } else if (platform === 'android' && rest.length === 1) {
        await this.verifyAndroid(challenge, rest[0]!);
      } else {
        throw new AttestationRefused('malformed');
      }
    });
  }

  private async verifyApple(
    challenge: string,
    keyId: string,
    assertion: string,
  ) {
    const db = database(this.txHost);
    const id = Buffer.from(keyId, 'base64url').toString('base64url');
    const [key] = await db
      .select()
      .from(appAttestKeys)
      .where(eq(appAttestKeys.keyId, id));
    if (!key) {
      throw new AttestationRefused('key');
    }
    const { counter } = verifyAppleAssertion({
      assertion: Buffer.from(assertion, 'base64url'),
      clientDataHash: clientDataHash(challenge),
      publicKey: Buffer.from(key.publicKey, 'base64url'),
      appId: key.appId,
      counter: key.counter,
    });
    // Conditional: of two assertions with one counter, one counts.
    const [counted] = await db
      .update(appAttestKeys)
      .set({ counter, updatedAt: new Date() })
      .where(
        and(eq(appAttestKeys.id, key.id), lt(appAttestKeys.counter, counter)),
      )
      .returning({ id: appAttestKeys.id });
    if (!counted) {
      throw new AttestationRefused('counter');
    }
  }

  private async verifyAndroid(challenge: string, token: string) {
    const decryptionKey = this.config.get('PLAY_INTEGRITY_DECRYPTION_KEY', {
      infer: true,
    });
    const verificationKey = this.config.get('PLAY_INTEGRITY_VERIFICATION_KEY', {
      infer: true,
    });
    if (!decryptionKey || !verificationKey) {
      throw new AttestationRefused('platform'); // Android not configured
    }
    await verifyPlayIntegrity({
      token,
      decryptionKey: Buffer.from(decryptionKey, 'base64'),
      verificationKey: createPublicKey({
        key: Buffer.from(verificationKey, 'base64'),
        format: 'der',
        type: 'spki',
      }),
      nonce: challenge,
      apps: this.config
        .get('PASSKEY_ANDROID_APPS', { infer: true })
        .map(androidApp),
    });
  }

  /** Spends the challenge; refused when unknown, used or expired. */
  private async takeChallenge(challenge: string) {
    if (
      challenge.length > 64 ||
      !(await this.redis.getdel(challengeKey(challenge)))
    ) {
      throw new AttestationRefused('challenge');
    }
  }

  /** `AttestationRefused` as the 403 a client reads. */
  private async refusing(work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      if (error instanceof AttestationRefused) {
        throw new ForbiddenException({
          code: 'attestation_invalid',
          message: t('auth.attestationInvalid'),
          reason: error.reason,
        });
      }
      throw error;
    }
  }

  private assertEnabled() {
    if (!this.enabled) {
      throw new NotFoundException();
    }
  }
}

/** The clientDataHash an app signs for `challenge`: its SHA-256 (of the base64url text). */
const clientDataHash = (challenge: string) =>
  createHash('sha256').update(challenge).digest();

const challengeKey = (challenge: string) =>
  `attestation:challenge:${challenge}`;
