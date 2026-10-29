import {
  createHash,
  timingSafeEqual,
  verify,
  X509Certificate,
} from 'node:crypto';
import {
  convertCertBufferToPEM,
  decodeAttestationObject,
  isoCBOR,
  parseAuthenticatorData,
  validateCertificatePath,
} from '@simplewebauthn/server/helpers';
import { compactDecrypt, compactVerify, type KeyObject } from 'jose';

/**
 * Apple App Attestation Root CA
 * (https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem,
 * SHA-256 1C:B9:82:3B:…:62:42:C9:32): what every attestation chains to.
 */
export const APPLE_APP_ATTESTATION_ROOT = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----
`;

/** Why an attestation or assertion was refused (the problem's `reason`). */
export class AttestationRefused extends Error {
  constructor(readonly reason: string) {
    super(`app attestation refused: ${reason}`);
  }
}

const sha256 = (...parts: Uint8Array[]) => {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest();
};

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && timingSafeEqual(a, b);

/** `aaguid` of App Attest's production environment, and of its development one. */
const AAGUID_PRODUCTION = Buffer.concat([
  Buffer.from('appattest'),
  Buffer.alloc(7),
]);
const AAGUID_DEVELOPMENT = Buffer.from('appattestdevelop');

/** The OID of the credential certificate's nonce extension, 1.2.840.113635.100.8.2, DER-encoded. */
const NONCE_EXTENSION = Buffer.from('06092a864886f763640802', 'hex');

/**
 * Apple's "Validating apps that connect to your server", steps 1 to 9: the
 * chain to Apple's root, the nonce over `authData` and the challenge's
 * hash, the key id, the app (`rpIdHash`), a counter of 0, the environment,
 * the credential id. The key's SPKI and its app, to store.
 *
 * Custom: @simplewebauthn/server verifies WebAuthn's formats, and App
 * Attest's (`apple-appattest`) is not one; its helpers decode the CBOR and
 * check the chain.
 */
export async function verifyAppleAttestation(input: {
  keyId: Buffer;
  attestation: Buffer;
  clientDataHash: Buffer;
  appIds: string[];
  development: boolean;
  roots?: string[];
}) {
  // Whatever the bytes decode to: anything but the expected shape is malformed.
  let fmt: unknown;
  let x5c: Uint8Array[] | undefined;
  let authData: Uint8Array;
  let parsed: ReturnType<typeof parseAuthenticatorData>;
  try {
    const decoded = decodeAttestationObject(new Uint8Array(input.attestation));
    fmt = decoded.get('fmt');
    x5c = decoded.get('attStmt').get('x5c');
    authData = decoded.get('authData');
    parsed = parseAuthenticatorData(new Uint8Array(authData));
  } catch {
    throw new AttestationRefused('malformed');
  }
  if (fmt !== 'apple-appattest') {
    throw new AttestationRefused('format');
  }
  if (
    !Array.isArray(x5c) ||
    x5c.length < 2 ||
    !x5c.every((cert) => cert instanceof Uint8Array)
  ) {
    throw new AttestationRefused('certificate');
  }
  try {
    await validateCertificatePath(
      x5c.map((cert) => convertCertBufferToPEM(new Uint8Array(cert))),
      input.roots ?? [APPLE_APP_ATTESTATION_ROOT],
    );
  } catch {
    throw new AttestationRefused('certificate');
  }
  const nonce = certificateNonce(Buffer.from(x5c[0]!));
  if (!nonce || !same(nonce, sha256(authData, input.clientDataHash))) {
    throw new AttestationRefused('nonce');
  }
  const publicKey = new X509Certificate(Buffer.from(x5c[0]!)).publicKey;
  const jwk = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url'),
  ]);
  if (!same(sha256(point), input.keyId)) {
    throw new AttestationRefused('key');
  }
  const appId = input.appIds.find((id) =>
    same(sha256(Buffer.from(id)), parsed.rpIdHash),
  );
  if (!appId) {
    throw new AttestationRefused('app');
  }
  const aaguid = Buffer.from(parsed.aaguid ?? []);
  if (
    parsed.counter !== 0 ||
    !(
      same(aaguid, AAGUID_PRODUCTION) ||
      (input.development && same(aaguid, AAGUID_DEVELOPMENT))
    ) ||
    !same(Buffer.from(parsed.credentialID ?? []), input.keyId)
  ) {
    throw new AttestationRefused('authenticator');
  }
  return {
    appId,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }),
  };
}

/**
 * Apple's "Assessing fraud risk"'s assertion checks: the signature over
 * the nonce (SHA-256 of `authenticatorData` and the challenge's hash) by
 * the stored key, the app, and a counter above the last one. The new
 * counter, to store.
 */
export function verifyAppleAssertion(input: {
  assertion: Buffer;
  clientDataHash: Buffer;
  publicKey: Buffer;
  appId: string;
  counter: number;
}) {
  let signature: Uint8Array | undefined;
  let authenticatorData: Uint8Array | undefined;
  try {
    const decoded = isoCBOR.decodeFirst<Map<string, Uint8Array>>(
      new Uint8Array(input.assertion),
    );
    signature = decoded.get('signature');
    authenticatorData = decoded.get('authenticatorData');
  } catch {
    throw new AttestationRefused('malformed');
  }
  if (
    !(signature instanceof Uint8Array) ||
    !(authenticatorData instanceof Uint8Array)
  ) {
    throw new AttestationRefused('malformed');
  }
  const nonce = sha256(authenticatorData, input.clientDataHash);
  const key = { key: input.publicKey, format: 'der', type: 'spki' } as const;
  if (!verify('sha256', nonce, key, signature)) {
    throw new AttestationRefused('signature');
  }
  let parsed: ReturnType<typeof parseAuthenticatorData>;
  try {
    parsed = parseAuthenticatorData(new Uint8Array(authenticatorData));
  } catch {
    throw new AttestationRefused('malformed');
  }
  if (!same(sha256(Buffer.from(input.appId)), parsed.rpIdHash)) {
    throw new AttestationRefused('app');
  }
  if (parsed.counter <= input.counter) {
    throw new AttestationRefused('counter');
  }
  return { counter: parsed.counter };
}

/**
 * The 32 bytes of the credential certificate's nonce extension:
 * `SEQUENCE { [1] { OCTET STRING nonce } }` in the extension's OCTET
 * STRING. Read from the DER by hand: node:crypto's X509Certificate has no
 * API for an extension it doesn't know.
 */
export function certificateNonce(der: Buffer): Buffer | undefined {
  const at = der.indexOf(NONCE_EXTENSION);
  if (at < 0) {
    return undefined;
  }
  let next = tlv(der, at + NONCE_EXTENSION.length);
  if (next?.tag === 0x01) {
    next = tlv(der, next.end); // `critical`
  }
  if (next?.tag !== 0x04) {
    return undefined;
  }
  const sequence = tlv(der, next.start);
  const tagged = sequence?.tag === 0x30 ? tlv(der, sequence.start) : undefined;
  const octets = tagged?.tag === 0xa1 ? tlv(der, tagged.start) : undefined;
  return octets?.tag === 0x04 && octets.end - octets.start === 32
    ? der.subarray(octets.start, octets.end)
    : undefined;
}

/** A DER tag, length and value's bounds at `offset`. */
function tlv(der: Buffer, offset: number) {
  if (offset + 2 > der.length) {
    return undefined;
  }
  const tag = der[offset]!;
  let length = der[offset + 1]!;
  let start = offset + 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    if (bytes === 0 || bytes > 2 || start + bytes > der.length) {
      return undefined;
    }
    length = der.readUIntBE(start, bytes);
    start += bytes;
  }
  const end = start + length;
  return end <= der.length ? { tag, start, end } : undefined;
}

/** An Android app of PASSKEY_ANDROID_APPS: its package and its signing certificate's SHA-256, base64url. */
export const androidApp = (entry: string) => {
  const [packageName, ...hex] = entry.split(':');
  return {
    packageName: packageName!,
    certificateDigest: Buffer.from(hex.join(''), 'hex').toString('base64url'),
  };
};

/** How old a Play Integrity verdict may be. */
const VERDICT_MAX_AGE_MS = 5 * 60_000;

const unpadded = (value: unknown) =>
  typeof value === 'string' ? value.replace(/=+$/, '') : undefined;

/**
 * A Play Integrity token (classic request), decrypted and verified here
 * with the keys from the Play Console (Google's "Decrypt and verify
 * locally": JWE A256KW / A256GCM around a JWS ES256): the challenge as its
 * nonce, recent, a Play-recognized build of a listed app and signing
 * certificate, on a device that meets device integrity.
 */
export async function verifyPlayIntegrity(input: {
  token: string;
  decryptionKey: Uint8Array;
  verificationKey: KeyObject;
  nonce: string;
  apps: { packageName: string; certificateDigest: string }[];
  now?: number;
}) {
  let verdict: {
    requestDetails?: {
      requestPackageName?: string;
      nonce?: string;
      timestampMillis?: string | number;
    };
    appIntegrity?: {
      appRecognitionVerdict?: string;
      packageName?: string;
      certificateSha256Digest?: string[];
    };
    deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
  };
  try {
    const { plaintext } = await compactDecrypt(
      input.token,
      input.decryptionKey,
      {
        keyManagementAlgorithms: ['A256KW'],
        contentEncryptionAlgorithms: ['A256GCM'],
      },
    );
    const { payload } = await compactVerify(
      new TextDecoder().decode(plaintext),
      input.verificationKey,
      { algorithms: ['ES256'] },
    );
    verdict = JSON.parse(new TextDecoder().decode(payload)) as typeof verdict;
  } catch {
    throw new AttestationRefused('malformed');
  }
  const { requestDetails, appIntegrity, deviceIntegrity } = verdict;
  if (unpadded(requestDetails?.nonce) !== unpadded(input.nonce)) {
    throw new AttestationRefused('nonce');
  }
  const at = Number(requestDetails?.timestampMillis);
  if (
    !Number.isFinite(at) ||
    Math.abs((input.now ?? Date.now()) - at) > VERDICT_MAX_AGE_MS
  ) {
    throw new AttestationRefused('expired');
  }
  const app = input.apps.find(
    (candidate) =>
      candidate.packageName === appIntegrity?.packageName &&
      candidate.packageName === requestDetails?.requestPackageName &&
      (appIntegrity.certificateSha256Digest ?? []).some(
        (digest) => unpadded(digest) === candidate.certificateDigest,
      ),
  );
  if (!app || appIntegrity?.appRecognitionVerdict !== 'PLAY_RECOGNIZED') {
    throw new AttestationRefused('app');
  }
  if (
    !deviceIntegrity?.deviceRecognitionVerdict?.includes(
      'MEETS_DEVICE_INTEGRITY',
    )
  ) {
    throw new AttestationRefused('device');
  }
  return { packageName: app.packageName };
}
