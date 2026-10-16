import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

/** What the authenticator keeps of a credential it made. */
export interface SoftwareCredential {
  /** The credential id, base64url. */
  id: string;
  rpId: string;
  /** The user handle the relying party gave it, base64url. */
  userHandle: string;
  privateKey: KeyObject;
  /** The signature counter; synced passkeys keep 0. */
  counter: number;
  synced: boolean;
}

interface CreationOptions {
  challenge: string;
  rp: { id?: string };
  user: { id: string };
}

interface RequestOptions {
  challenge: string;
  rpId?: string;
  allowCredentials?: { id: string }[];
}

export interface CeremonyFlags {
  /** The page's origin, as the browser writes it into `clientDataJSON`. */
  origin?: string;
  /** User verification (`uv`): a PIN, a fingerprint. Default true. */
  uv?: boolean;
  /** Another challenge than the options' (a forged or replayed one). */
  challenge?: string;
}

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | string) =>
  createHash('sha256').update(data).digest();

/**
 * A WebAuthn authenticator in software, for the e2e tests: ES256 keys from
 * node:crypto, `none` attestation, the authenticator data and signatures as
 * the WebAuthn spec lays them out (the server verifies them with
 * @simplewebauthn/server, as it would a real one). It plays the browser
 * too: `clientDataJSON` with the challenge and the origin it is given.
 * `synced` credentials keep the counter at 0 (iCloud Keychain, Google
 * Password Manager); the others count up on each use.
 */
export class SoftwareAuthenticator {
  readonly credentials: SoftwareCredential[] = [];

  constructor(
    private readonly defaults: { origin: string; synced?: boolean },
  ) {}

  /** `navigator.credentials.create()`: a new credential for the options' RP and user. */
  create(options: CreationOptions, flags: CeremonyFlags = {}) {
    const rpId = options.rp.id!;
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const jwk = publicKey.export({ format: 'jwk' });
    const credentialId = randomBytes(16);
    const synced = this.defaults.synced ?? false;
    const credential: SoftwareCredential = {
      id: b64url(credentialId),
      rpId,
      userHandle: options.user.id,
      privateKey,
      counter: 0,
      synced,
    };
    // COSE_Key (RFC 9053): EC2, ES256, P-256, x, y.
    const coseKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Uint8Array.from(Buffer.from(jwk.x!, 'base64url'))],
        [-3, Uint8Array.from(Buffer.from(jwk.y!, 'base64url'))],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credentialId.length);
    const authData = Buffer.concat([
      this.authenticatorData(rpId, flags.uv ?? true, synced, 0, true),
      Buffer.alloc(16), // AAGUID: zeros, as `none` attestation gives on most platforms
      idLength,
      credentialId,
      Buffer.from(coseKey),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, string>>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, string>()],
        ['authData', Uint8Array.from(authData)],
      ]),
    );
    this.credentials.push(credential);
    return {
      credential,
      response: {
        id: credential.id,
        rawId: credential.id,
        type: 'public-key' as const,
        response: {
          clientDataJSON: this.clientData(
            'webauthn.create',
            flags.challenge ?? options.challenge,
            flags.origin,
          ),
          attestationObject: b64url(attestationObject),
          transports: ['internal', 'hybrid'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform' as const,
      },
    };
  }

  /**
   * `navigator.credentials.get()`: an assertion by `credential` (default:
   * the first one the options allow, or, usernameless, the first one held
   * for the RP). The counter moves on, unless the credential is synced.
   */
  get(
    options: RequestOptions,
    flags: CeremonyFlags & { credential?: SoftwareCredential } = {},
  ) {
    const rpId = options.rpId!;
    const allowed = options.allowCredentials?.map((entry) => entry.id);
    const credential =
      flags.credential ??
      this.credentials.find(
        (candidate) =>
          candidate.rpId === rpId &&
          (!allowed || allowed.includes(candidate.id)),
      );
    if (!credential) {
      throw new Error('No credential for these options');
    }
    if (!credential.synced) {
      credential.counter += 1;
    }
    const authData = this.authenticatorData(
      rpId,
      flags.uv ?? true,
      credential.synced,
      credential.counter,
      false,
    );
    const clientDataJSON = this.clientData(
      'webauthn.get',
      flags.challenge ?? options.challenge,
      flags.origin,
    );
    const signature = sign(
      'sha256',
      Buffer.concat([
        authData,
        sha256(Buffer.from(clientDataJSON, 'base64url')),
      ]),
      credential.privateKey,
    );
    return {
      id: credential.id,
      rawId: credential.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON,
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: credential.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }

  /** RP ID hash, flags (UP, UV, BE, BS, AT), the counter (big-endian). */
  private authenticatorData(
    rpId: string,
    uv: boolean,
    synced: boolean,
    counter: number,
    attested: boolean,
  ) {
    const flags =
      0x01 | // user present
      (uv ? 0x04 : 0) |
      (synced ? 0x08 | 0x10 : 0) | // backup eligible, backed up
      (attested ? 0x40 : 0);
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), count]);
  }

  private clientData(type: string, challenge: string, origin?: string) {
    return b64url(
      JSON.stringify({
        type,
        challenge,
        origin: origin ?? this.defaults.origin,
        crossOrigin: false,
      }),
    );
  }
}
