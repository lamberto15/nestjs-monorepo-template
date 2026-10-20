import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/*
 * Personal data at rest (roadmap item 5, docs/encryption.md): AES-256-GCM
 * and HMAC-SHA-256 from Node's own `node:crypto`, the primitives the Node
 * documentation gives for authenticated encryption and keyed hashes.
 * Custom code: the ciphers of @nestjs/authentication (MFA), @nestjs/webhooks
 * and @nestjs/idempotency are internal to those packages (not exported, no
 * pluggable option), so the template's own columns get this one.
 *
 * Stored form: `v1.<key id>.<iv>.<ciphertext>.<tag>`, each part base64url,
 * the same shape as the packages' sealed values. The first part is the
 * **format version**, and it names what the additional data (AAD) binds:
 *
 * - `v1`: the table, the column and the tenant (`v1|table.column|tenant`).
 *   A value copied to another column, table or tenant fails to open; a value
 *   swapped between two rows of one tenant's column still opens.
 *
 * A later format (`v2`: the row's id too) only adds a version: every stored
 * value names its own, so old rows still open and the re-encryption job
 * moves them over. The version is inside the AAD as well, so a value can't
 * be relabelled to another format.
 *
 * The second part is the **key version**: an id derived from the key (the
 * first 6 base64url characters of its hash), so the key list in the
 * environment needs no ids of its own. The first key encrypts, every key
 * decrypts; the re-encryption job rewrites rows still on an older one.
 */

/** The format written today. */
export const FORMAT = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Key material shorter than this is refused: `openssl rand -base64 32` gives 44. */
export const MIN_KEY_LENGTH = 32;
/** HKDF labels: one key string never yields the same bytes for two uses. */
const DATA_KEY_INFO = 'app-data-encryption:v1';
const INDEX_KEY_INFO = 'app-blind-index:v1';

interface DerivedKey {
  /** The key version written into every value. */
  id: string;
  key: Buffer;
}

function derive(
  material: string,
  info: string,
  variable: string,
  index: number,
): DerivedKey {
  if (material.length < MIN_KEY_LENGTH) {
    throw new TypeError(
      `${variable}[${index}] must be a random string of at least ${MIN_KEY_LENGTH} characters (openssl rand -base64 32).`,
    );
  }
  const key = Buffer.from(
    hkdfSync('sha256', material, Buffer.alloc(0), info, 32),
  );
  return {
    id: createHash('sha256').update(key).digest('base64url').slice(0, 6),
    key,
  };
}

function deriveAll(
  materials: readonly string[],
  info: string,
  variable: string,
): DerivedKey[] {
  const keys = materials.map((material, index) =>
    derive(material, info, variable, index),
  );
  const ids = new Set(keys.map((key) => key.id));
  if (ids.size !== keys.length) {
    throw new TypeError(`${variable} lists the same key twice.`);
  }
  return keys;
}

/**
 * What a value is bound to: its table, its column and its tenant (`null`:
 * a table of no tenant). The names are the database's; a renamed column
 * keeps its old name here (`aad` in `encryptedColumn()`), or its values no
 * longer open.
 */
export interface Binding {
  table: string;
  column: string;
  tenantId: string | null;
}

const aadOf = (format: string, { table, column, tenantId }: Binding) =>
  Buffer.from(`${format}|${table}.${column}|${tenantId ?? ''}`, 'utf8');

/** Why a stored value didn't open. Never the value or the key. */
export class DecryptionError extends Error {
  constructor(
    readonly reason:
      'malformed' | 'unknown_format' | 'unknown_key' | 'authentication_failed',
    binding: Binding,
  ) {
    super(
      `An encrypted value of ${binding.table}.${binding.column} did not open: ${reason.replace('_', ' ')}.`,
    );
    this.name = 'DecryptionError';
  }
}

/** The parts of a stored value, or undefined when it isn't one. */
export function parseEncrypted(stored: string) {
  const parts = stored.split('.');
  if (parts.length !== 5 || parts.some((part) => part === '')) {
    return undefined;
  }
  const [format, keyId, iv, ciphertext, tag] = parts;
  return { format, keyId, iv, ciphertext, tag };
}

/** Encrypts and decrypts with one deployment's keys (DATA_ENCRYPTION_KEYS). */
export class DataCipher {
  private readonly keys: DerivedKey[];

  /** `keys`: newest first; the first encrypts. */
  constructor(keys: readonly string[], variable = 'DATA_ENCRYPTION_KEYS') {
    this.keys = deriveAll(keys, DATA_KEY_INFO, variable);
  }

  /** Whether any key is configured. */
  get configured() {
    return this.keys.length > 0;
  }

  /** The key version new values are written with; undefined without keys. */
  get currentKeyId(): string | undefined {
    return this.keys[0]?.id;
  }

  /** Every configured key version, newest first. */
  get keyIds(): string[] {
    return this.keys.map((key) => key.id);
  }

  encrypt(plaintext: string, binding: Binding): string {
    const current = this.keys[0];
    if (!current) {
      throw new Error(
        `${binding.table}.${binding.column} is encrypted, and DATA_ENCRYPTION_KEYS is not set.`,
      );
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, current.key, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aadOf(FORMAT, binding));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [
      FORMAT,
      current.id,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  /** The plaintext, or a DecryptionError saying why not. */
  decrypt(stored: string, binding: Binding): string {
    const parts = parseEncrypted(stored);
    if (!parts) {
      throw new DecryptionError('malformed', binding);
    }
    if (parts.format !== FORMAT) {
      throw new DecryptionError('unknown_format', binding);
    }
    const entry = this.keys.find((key) => key.id === parts.keyId);
    if (!entry) {
      throw new DecryptionError('unknown_key', binding);
    }
    const iv = Buffer.from(parts.iv, 'base64url');
    const tag = Buffer.from(parts.tag, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new DecryptionError('malformed', binding);
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, entry.key, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aadOf(parts.format, binding));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(parts.ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new DecryptionError('authentication_failed', binding);
    }
  }

  /** The key version a stored value was written with, undefined when it isn't one. */
  keyIdOf(stored: string): string | undefined {
    return parseEncrypted(stored)?.keyId;
  }

  /** Whether a stored value is in today's format under the current key. */
  isCurrent(stored: string): boolean {
    const parts = parseEncrypted(stored);
    return parts?.format === FORMAT && parts.keyId === this.currentKeyId;
  }
}

/**
 * Blind indexes (BLIND_INDEX_KEYS): an HMAC-SHA-256 of the normalized
 * value, bound like the ciphertext (table, column, tenant), so equal values
 * can be looked up without decrypting, and the same value in two tenants
 * or two columns gives two unrelated indexes. Stored as `<key id>.<mac>`:
 * while the key rotates, a lookup asks for every key's index
 * (`indexes()`), and the re-encryption job rewrites the old ones.
 */
export class BlindIndexer {
  private readonly keys: DerivedKey[];

  constructor(keys: readonly string[], variable = 'BLIND_INDEX_KEYS') {
    this.keys = deriveAll(keys, INDEX_KEY_INFO, variable);
  }

  get configured() {
    return this.keys.length > 0;
  }

  get currentKeyId(): string | undefined {
    return this.keys[0]?.id;
  }

  /** The index under the current key. */
  index(normalized: string, binding: Binding): string {
    const current = this.keys[0];
    if (!current) {
      throw new Error(
        `${binding.table}.${binding.column} has a blind index, and BLIND_INDEX_KEYS is not set.`,
      );
    }
    return this.mac(current, normalized, binding);
  }

  /** The index under every key, newest first: what a lookup matches during a rotation. */
  indexes(normalized: string, binding: Binding): string[] {
    return this.keys.map((key) => this.mac(key, normalized, binding));
  }

  /** Whether `stored` is the index of `normalized` under any key (constant time per key). */
  matches(stored: string, normalized: string, binding: Binding): boolean {
    const given = Buffer.from(stored, 'utf8');
    return this.indexes(normalized, binding).some((candidate) => {
      const expected = Buffer.from(candidate, 'utf8');
      return (
        expected.length === given.length && timingSafeEqual(expected, given)
      );
    });
  }

  /** The key version of a stored index, undefined when it isn't one. */
  keyIdOf(stored: string): string | undefined {
    const [id, mac, ...rest] = stored.split('.');
    return id && mac && rest.length === 0 ? id : undefined;
  }

  private mac(key: DerivedKey, normalized: string, binding: Binding) {
    const mac = createHmac('sha256', key.key)
      .update(aadOf(FORMAT, binding))
      .update('|')
      .update(normalized, 'utf8')
      .digest('base64url');
    return `${key.id}.${mac}`;
  }
}

/**
 * How a value is normalized before its blind index is computed, so the
 * spellings people type of one value find each other. The index is of the
 * normalized value; the ciphertext keeps what was given.
 */
export type Normalizer = (value: string) => string;

export const normalizers = {
  /** Trimmed, Unicode NFC, lower-cased: e-mail addresses. */
  email: (value: string) => value.trim().normalize('NFC').toLowerCase(),
  /** Trimmed, NFC, inner runs of white space as one space, lower-cased: names, ids people type. */
  text: (value: string) =>
    value.trim().normalize('NFC').replace(/\s+/g, ' ').toLowerCase(),
  /** As given, trimmed and NFC only: case matters (tax numbers with letters, codes). */
  exact: (value: string) => value.trim().normalize('NFC'),
  /**
   * E.164 (`+` and up to 15 digits): spaces, dots, dashes and brackets
   * dropped, a leading `00` read as `+`. A number without its country code
   * can't be normalized without knowing the country, so it is refused
   * rather than indexed under a guess.
   */
  phone: (value: string) => {
    const compact = value.trim().replace(/[\s().-]/g, '');
    const international = compact.startsWith('00')
      ? `+${compact.slice(2)}`
      : compact;
    if (!/^\+[1-9]\d{6,14}$/.test(international)) {
      throw new TypeError(
        'A phone number needs its country code (E.164: +4930123456).',
      );
    }
    return international;
  },
} satisfies Record<string, Normalizer>;
