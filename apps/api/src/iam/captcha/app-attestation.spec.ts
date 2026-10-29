import { execFileSync } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
} from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { CompactEncrypt, CompactSign } from 'jose';
import {
  androidApp,
  AttestationRefused,
  certificateNonce,
  verifyAppleAssertion,
  verifyAppleAttestation,
  verifyPlayIntegrity,
} from './app-attestation.js';

const APP_ID = 'ABCDE12345.com.example.app';
const sha256 = (...parts: Uint8Array[]) => {
  const hash = createHash('sha256');
  parts.forEach((part) => hash.update(part));
  return hash.digest();
};
const refusal = (work: () => unknown) =>
  Promise.resolve()
    .then(work)
    .then(
      () => 'passed',
      (error: unknown) =>
        error instanceof AttestationRefused ? error.reason : error,
    );

/**
 * An App Attest key and its attestation, as a device would make them, but
 * chained to a root made here (openssl: node:crypto signs no certificate).
 */
function appleDevice(challenge: string) {
  const dir = mkdtempSync(join(tmpdir(), 'app-attest-'));
  const run = (...args: string[]) =>
    execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
  run(
    'req',
    '-x509',
    ...ec,
    '-keyout',
    'root-k.pem',
    '-out',
    'root.pem',
    '-subj',
    '/CN=Test Root',
    '-days',
    '1',
    '-addext',
    'basicConstraints=critical,CA:true',
    '-addext',
    'keyUsage=critical,keyCertSign',
  );
  run(
    'req',
    ...ec,
    '-keyout',
    'ca-k.pem',
    '-out',
    'ca.csr',
    '-subj',
    '/CN=Test CA',
  );
  writeFileSync(
    join(dir, 'ca.ext'),
    'basicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign\n',
  );
  run(
    'x509',
    '-req',
    '-in',
    'ca.csr',
    '-CA',
    'root.pem',
    '-CAkey',
    'root-k.pem',
    '-CAcreateserial',
    '-out',
    'ca.pem',
    '-days',
    '1',
    '-extfile',
    'ca.ext',
  );

  const device = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = device.publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x!, 'base64url');
  const y = Buffer.from(jwk.y!, 'base64url');
  const keyId = sha256(Buffer.concat([Buffer.from([4]), x, y]));
  const authData = Buffer.concat([
    sha256(Buffer.from(APP_ID)),
    Buffer.from([0x40]),
    Buffer.alloc(4), // counter 0
    Buffer.concat([Buffer.from('appattest'), Buffer.alloc(7)]),
    Buffer.from([0, 32]),
    keyId,
    Buffer.from(
      isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, new Uint8Array(x)],
          [-3, new Uint8Array(y)],
        ]),
      ),
    ),
  ]);
  const nonce = sha256(authData, sha256(Buffer.from(challenge)));
  writeFileSync(
    join(dir, 'leaf-k.pem'),
    device.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  );
  run(
    'req',
    '-new',
    '-key',
    'leaf-k.pem',
    '-out',
    'leaf.csr',
    '-subj',
    '/CN=key',
  );
  writeFileSync(
    join(dir, 'leaf.ext'),
    `1.2.840.113635.100.8.2=DER:3024a1220420${nonce.toString('hex')}\n`,
  );
  run(
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca-k.pem',
    '-CAcreateserial',
    '-out',
    'leaf.pem',
    '-days',
    '1',
    '-extfile',
    'leaf.ext',
  );
  const der = (file: string) =>
    new Uint8Array(new X509Certificate(readFileSync(join(dir, file))).raw);
  const attestation = Buffer.from(
    isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'apple-appattest'],
        [
          'attStmt',
          new Map<string, unknown>([
            ['x5c', [der('leaf.pem'), der('ca.pem')]],
            ['receipt', new Uint8Array(4)],
          ]),
        ],
        ['authData', new Uint8Array(authData)],
      ]) as never,
    ),
  );
  return {
    keyId,
    attestation,
    signer: device.privateKey,
    root: readFileSync(join(dir, 'root.pem'), 'utf8'),
    leaf: Buffer.from(der('leaf.pem')),
    nonce,
  };
}

describe('App Attest', () => {
  const challenge = randomBytes(32).toString('base64url');
  const device = appleDevice(challenge);
  const attest = (
    overrides: Partial<Parameters<typeof verifyAppleAttestation>[0]> = {},
  ) =>
    verifyAppleAttestation({
      keyId: device.keyId,
      attestation: device.attestation,
      clientDataHash: sha256(Buffer.from(challenge)),
      appIds: [APP_ID],
      development: false,
      roots: [device.root],
      ...overrides,
    });

  it('reads the nonce extension of the credential certificate', () => {
    expect(certificateNonce(device.leaf)).toEqual(device.nonce);
    expect(certificateNonce(Buffer.from('no extension'))).toBeUndefined();
  });

  it('accepts an attestation chained to the root, for a listed app, over the challenge', async () => {
    const { appId, publicKey } = await attest();
    expect(appId).toBe(APP_ID);
    expect(publicKey.length).toBeGreaterThan(0);
  });

  it('refuses another root, another app, another challenge, another key', async () => {
    expect(await refusal(() => attest({ roots: undefined }))).toBe(
      'certificate',
    );
    expect(await refusal(() => attest({ appIds: ['ABCDE12345.other'] }))).toBe(
      'app',
    );
    expect(
      await refusal(() =>
        attest({ clientDataHash: sha256(Buffer.from('other')) }),
      ),
    ).toBe('nonce');
    expect(await refusal(() => attest({ keyId: randomBytes(32) }))).toBe('key');
    expect(await refusal(() => attest({ attestation: Buffer.from('x') }))).toBe(
      'malformed',
    );
    // CBOR that decodes, to something else than a map.
    expect(await refusal(() => attest({ attestation: Buffer.from([0]) }))).toBe(
      'malformed',
    );
  });

  it('accepts an assertion by the key over the challenge, counting up', async () => {
    const { publicKey } = await attest();
    const assertion = (count: number, signer = device.signer) => {
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(count);
      const authenticatorData = Buffer.concat([
        sha256(Buffer.from(APP_ID)),
        Buffer.from([0]),
        counter,
      ]);
      const nonce = sha256(authenticatorData, sha256(Buffer.from(challenge)));
      return Buffer.from(
        isoCBOR.encode(
          new Map<string, Uint8Array>([
            ['signature', new Uint8Array(sign('sha256', nonce, signer))],
            ['authenticatorData', new Uint8Array(authenticatorData)],
          ]),
        ),
      );
    };
    const check =
      (made: Buffer, counter = 0) =>
      () =>
        verifyAppleAssertion({
          assertion: made,
          clientDataHash: sha256(Buffer.from(challenge)),
          publicKey,
          appId: APP_ID,
          counter,
        });
    expect(check(assertion(1))()).toEqual({ counter: 1 });
    expect(await refusal(check(assertion(1), 1))).toBe('counter');
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(await refusal(check(assertion(2, other.privateKey)))).toBe(
      'signature',
    );
  });
});

describe('Play Integrity', () => {
  const decryptionKey = randomBytes(32);
  const signing = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const app = androidApp(
    `com.example.app:${Array.from({ length: 32 }, () => 'AB').join(':')}`,
  );
  const nonce = randomBytes(32).toString('base64url');
  const verdict = (overrides: Record<string, unknown> = {}) => ({
    requestDetails: {
      requestPackageName: app.packageName,
      nonce,
      timestampMillis: String(Date.now()),
    },
    appIntegrity: {
      appRecognitionVerdict: 'PLAY_RECOGNIZED',
      packageName: app.packageName,
      certificateSha256Digest: [app.certificateDigest],
    },
    deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
    ...overrides,
  });
  const integrityToken = async (payload: unknown) => {
    const jws = await new CompactSign(Buffer.from(JSON.stringify(payload)))
      .setProtectedHeader({ alg: 'ES256' })
      .sign(signing.privateKey);
    return new CompactEncrypt(Buffer.from(jws))
      .setProtectedHeader({ alg: 'A256KW', enc: 'A256GCM' })
      .encrypt(decryptionKey);
  };
  const verified = (made: string) =>
    refusal(() =>
      verifyPlayIntegrity({
        token: made,
        decryptionKey,
        verificationKey: signing.publicKey,
        nonce,
        apps: [app],
      }),
    );
  const check = async (payload: unknown) =>
    verified(await integrityToken(payload));
  const details = verdict().requestDetails;
  const integrity = verdict().appIntegrity;

  it('accepts a recognized build of a listed app, on a device with integrity, for the challenge', async () => {
    expect(await check(verdict())).toBe('passed');
  });

  it('refuses another nonce, an old verdict, another app, a device without integrity', async () => {
    expect(
      await check(verdict({ requestDetails: { ...details, nonce: 'other' } })),
    ).toBe('nonce');
    expect(
      await check(
        verdict({ requestDetails: { ...details, timestampMillis: '1' } }),
      ),
    ).toBe('expired');
    expect(
      await check(
        verdict({
          appIntegrity: {
            ...integrity,
            appRecognitionVerdict: 'UNRECOGNIZED_VERSION',
          },
        }),
      ),
    ).toBe('app');
    expect(
      await check(
        verdict({
          appIntegrity: { ...integrity, certificateSha256Digest: ['other'] },
        }),
      ),
    ).toBe('app');
    expect(await check(verdict({ deviceIntegrity: {} }))).toBe('device');
    expect(await verified(['not', 'a', 'jwe'].join('.'))).toBe('malformed');
  });
});
