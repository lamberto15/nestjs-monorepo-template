import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/*
 * Sealed list cursors: a sorted list's `nextCursor` holds the last row's
 * sort values, which may be fields the caller can't see on that row
 * (field-level permissions redact the items, not the cursor). So the cursor
 * is AES-256-GCM ciphertext under a server key (CURSOR_KEYS, newest first),
 * bound to the sort it was made for (additional authenticated data): a
 * client can neither read it nor change it nor replay it with another sort.
 *
 * Custom code: @nestjs/idempotency, @nestjs/webhooks and @nestjs/authentication
 * each seal with AES-256-GCM, but none exports its cipher (they are internal
 * to the packages), and the cursor is opened inside the list query's Zod
 * schema, synchronously, so the keys are set once at boot (CoreModule)
 * rather than injected.
 */

const ALGORITHM = 'aes-256-gcm';
/** 96-bit IV, the GCM recommendation. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** The HKDF label that makes the cursor key from a CURSOR_KEYS entry. */
const KEY_LABEL = 'nestjs-monorepo-template/list-cursor/v1';
const MIN_SECRET_LENGTH = 32;

interface CursorKey {
  /** A truncated hash of the key: lets rotation pick the key, tells nothing about it. */
  id: string;
  key: Buffer;
}

function deriveKey(material: string, index: number): CursorKey {
  if (material.length < MIN_SECRET_LENGTH) {
    throw new TypeError(
      `CURSOR_KEYS[${index}] must be a random string of at least ${MIN_SECRET_LENGTH} characters (openssl rand -base64 32).`,
    );
  }
  const key = Buffer.from(
    hkdfSync('sha256', material, Buffer.alloc(0), KEY_LABEL, 32),
  );
  const id = createHash('sha256').update(key).digest('base64url').slice(0, 6);
  return { id, key };
}

let keys: CursorKey[] | undefined;

/**
 * The keys cursors are sealed with: the first seals, every one opens.
 * CoreModule sets them at boot from CURSOR_KEYS (or the one kept in
 * `app_secrets`); until then (unit tests, scripts) a random key of this
 * process, whose cursors no other process opens.
 */
export function useCursorKeys(materials: readonly string[]) {
  const list = materials.map((key) => key.trim()).filter(Boolean);
  if (!list.length) {
    throw new TypeError(
      'CURSOR_KEYS must list at least one key, newest first.',
    );
  }
  keys = list.map(deriveKey);
}

const currentKeys = () =>
  (keys ??= [deriveKey(randomBytes(32).toString('base64'), 0)]);

/** `plaintext` sealed for `context` (the sort): `<key id>.<base64url(iv | ciphertext | tag)>`. */
export function sealCursor(plaintext: string, context: string): string {
  const { id, key } = currentKeys()[0];
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const sealed = Buffer.concat([
    iv,
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${id}.${sealed.toString('base64url')}`;
}

/**
 * What `sealCursor()` sealed for `context`, or undefined: another context
 * (sort), a key no longer listed, changed or not a cursor at all.
 */
export function openCursor(
  cursor: string,
  context: string,
): string | undefined {
  const [id, body, ...rest] = cursor.split('.');
  if (rest.length || !body) {
    return undefined;
  }
  const entry = currentKeys().find((key) => key.id === id);
  if (!entry) {
    return undefined;
  }
  const sealed = Buffer.from(body, 'base64url');
  if (sealed.length < IV_BYTES + TAG_BYTES) {
    return undefined;
  }
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      entry.key,
      sealed.subarray(0, IV_BYTES),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return undefined;
  }
}
