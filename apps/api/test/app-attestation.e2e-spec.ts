import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  sign,
} from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { CompactEncrypt, CompactSign } from 'jose';
import type { Database } from '../src/core/database/drizzle.js';
import { appAttestKeys } from '../src/iam/iam.tables.js';
import { bootApp, type TestApp, testHooks } from './support.js';

const ANDROID_APP = `com.example.app:${Array.from({ length: 32 }, () => 'AB').join(':')}`;
const APPLE_APP = 'ABCDE12345.com.example.app';

// Read when AppModule loads: a captcha always asked for, and app
// attestation on for an Android and an iOS app, with Play Integrity keys
// made for the run (the Play Console's, in production).
const keys = await vi.hoisted(async () => {
  const { startSiteverify } = await import('./captcha-stand-in.js');
  const crypto = await import('node:crypto');
  const stand = await startSiteverify();
  const decryption = crypto.randomBytes(32);
  const signing = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  Object.assign(process.env, {
    CAPTCHA_MODE: 'always',
    APP_ATTESTATION: 'on',
    PASSKEY_ANDROID_APPS: `com.example.app:${Array.from({ length: 32 }, () => 'AB').join(':')}`,
    PASSKEY_APPLE_APPS: 'ABCDE12345.com.example.app',
    PLAY_INTEGRITY_DECRYPTION_KEY: decryption.toString('base64'),
    PLAY_INTEGRITY_VERIFICATION_KEY: signing.publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64'),
  });
  return { stand, decryption, signing };
});

const ip = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const sha256 = (...parts: Uint8Array[]) => {
  const hash = createHash('sha256');
  parts.forEach((part) => hash.update(part));
  return hash.digest();
};

describe('app attestation in place of the captcha (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    // The admin's own sign-in, made by bootApp, solves the widget.
    testHooks.captchaToken = () => keys.stand.token();
    node = await bootApp();
  });
  afterAll(async () => {
    delete testHooks.captchaToken;
    await node.close();
    await keys.stand.close();
  });

  const challenge = async () =>
    (await node.http().post('/v1/auth/app-attestation/challenge').expect(200))
      .body.challenge as string;

  /** A token sign-in with the admin's credentials, with this proof. */
  const signIn = (attestation?: string) => {
    const req = node.http().post('/v1/auth/token').set('X-Forwarded-For', ip());
    if (attestation) {
      req.set('X-App-Attestation', attestation);
    }
    return req.send({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    });
  };

  /** Play Integrity's token for `nonce`, as Play would give the app. */
  async function integrityToken(
    nonce: string,
    device = 'MEETS_DEVICE_INTEGRITY',
  ) {
    const jws = await new CompactSign(
      Buffer.from(
        JSON.stringify({
          requestDetails: {
            requestPackageName: 'com.example.app',
            nonce,
            timestampMillis: String(Date.now()),
          },
          appIntegrity: {
            appRecognitionVerdict: 'PLAY_RECOGNIZED',
            packageName: 'com.example.app',
            certificateSha256Digest: [
              Buffer.from(
                ANDROID_APP.split(':').slice(1).join(''),
                'hex',
              ).toString('base64url'),
            ],
          },
          deviceIntegrity: { deviceRecognitionVerdict: [device] },
        }),
      ),
    )
      .setProtectedHeader({ alg: 'ES256' })
      .sign(keys.signing.privateKey);
    return new CompactEncrypt(Buffer.from(jws))
      .setProtectedHeader({ alg: 'A256KW', enc: 'A256GCM' })
      .encrypt(keys.decryption);
  }

  it('asks for a captcha or a proof, and lets a genuine Android build in, once per challenge', async () => {
    const asked = await signIn().expect(403);
    expect(asked.body).toMatchObject({
      code: 'captcha_required',
      appAttestation: true,
    });
    const nonce = await challenge();
    const proof = `android ${nonce} ${await integrityToken(nonce)}`;
    await signIn(proof).expect(200);
    // The challenge is spent.
    const replayed = await signIn(proof).expect(403);
    expect(replayed.body).toMatchObject({
      code: 'attestation_invalid',
      reason: 'challenge',
    });
    const other = await challenge();
    const rooted = await signIn(
      `android ${other} ${await integrityToken(other, 'MEETS_BASIC_INTEGRITY')}`,
    ).expect(403);
    expect(rooted.body.reason).toBe('device');
  });

  it('lets an iOS install in with an assertion by its registered key, counting up', async () => {
    const device = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const keyId = randomBytes(32).toString('base64url');
    await node.app
      .get<Database>(getDrizzleToken())
      .insert(appAttestKeys)
      .values({
        keyId,
        appId: APPLE_APP,
        publicKey: device.publicKey
          .export({ type: 'spki', format: 'der' })
          .toString('base64url'),
      });
    const assertion = (nonce: string, count: number) => {
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(count);
      const authenticatorData = Buffer.concat([
        sha256(Buffer.from(APPLE_APP)),
        Buffer.from([0]),
        counter,
      ]);
      const signed = sha256(authenticatorData, sha256(Buffer.from(nonce)));
      return Buffer.from(
        isoCBOR.encode(
          new Map<string, Uint8Array>([
            [
              'signature',
              new Uint8Array(sign('sha256', signed, device.privateKey)),
            ],
            ['authenticatorData', new Uint8Array(authenticatorData)],
          ]),
        ),
      ).toString('base64url');
    };
    const first = await challenge();
    await signIn(`ios ${first} ${keyId} ${assertion(first, 1)}`).expect(200);
    const second = await challenge();
    const stale = await signIn(
      `ios ${second} ${keyId} ${assertion(second, 1)}`,
    ).expect(403);
    expect(stale.body.reason).toBe('counter');
    // A registration needs Apple's attestation.
    const refused = await node
      .http()
      .post('/v1/auth/app-attestation/keys')
      .send({ keyId: 'abc', attestation: 'AAAA', challenge: await challenge() })
      .expect(403);
    expect(refused.body.code).toBe('attestation_invalid');
  });
});
