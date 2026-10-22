import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/*
 * Incoming senders' secrets at rest, sealed exactly as @nestjs/webhooks seals
 * its outgoing endpoints' (`sealed.v1.<key id>.<iv>.<ciphertext>.<tag>`,
 * AES-256-GCM, the row's id as additional data, `WEBHOOKS_ENCRYPTION_KEYS`:
 * the first key seals, every key opens; unset, plaintext, and a plaintext
 * value still opens).
 *
 * Custom code: the package's `SecretCipher` is not exported, and its
 * receivers take one fixed secret at startup, not one per tenant.
 */
const PREFIX = 'sealed.v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
/** The package's HKDF label: the same keys open the same format. */
const HKDF_INFO = 'nestjs-webhooks:v1';
const MIN_SECRET_LENGTH = 32;

interface SealKey {
  id: string;
  key: Buffer;
}

function deriveKey(material: string, index: number): SealKey {
  if (material.length < MIN_SECRET_LENGTH) {
    throw new TypeError(
      `WEBHOOKS_ENCRYPTION_KEYS[${index}] must be a random string of at least ${MIN_SECRET_LENGTH} characters (openssl rand -base64 32).`,
    );
  }
  const key = Buffer.from(
    hkdfSync('sha256', material, Buffer.alloc(0), HKDF_INFO, 32),
  );
  return {
    id: createHash('sha256').update(key).digest('base64url').slice(0, 6),
    key,
  };
}

/** Seals and opens the secrets of one deployment's keys. */
export class SenderSecretCipher {
  private readonly keys: SealKey[];

  /** `keys`: newest first; none: secrets are stored as they are. */
  constructor(keys: readonly string[] = []) {
    this.keys = keys.map((material, index) => deriveKey(material, index));
  }

  /** From `WEBHOOKS_ENCRYPTION_KEYS` (comma separated, newest first). */
  static fromEnv(value = process.env.WEBHOOKS_ENCRYPTION_KEYS) {
    return new SenderSecretCipher(
      value ? value.split(',').map((key) => key.trim()) : [],
    );
  }

  seal(senderId: string, secret: string): string {
    const current = this.keys[0];
    if (!current) {
      return secret;
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, current.key, iv);
    cipher.setAAD(Buffer.from(senderId, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final(),
    ]);
    return [
      PREFIX,
      current.id,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  /** The secret, or undefined when it is sealed for another sender, tampered with or under an unknown key. */
  open(senderId: string, stored: string): string | undefined {
    if (!stored.startsWith(`${PREFIX}.`)) {
      return stored;
    }
    const [, , id, iv, ciphertext, tag, ...rest] = stored.split('.');
    const entry = this.keys.find((key) => key.id === id);
    if (!entry || !iv || !ciphertext || !tag || rest.length > 0) {
      return undefined;
    }
    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        entry.key,
        Buffer.from(iv, 'base64url'),
      );
      decipher.setAAD(Buffer.from(senderId, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return undefined;
    }
  }
}

/** A new secret, in the shape of the outgoing endpoints': `whsec_` and 32 random bytes in base64. */
export const generateSenderSecret = () =>
  `whsec_${randomBytes(32).toString('base64')}`;
