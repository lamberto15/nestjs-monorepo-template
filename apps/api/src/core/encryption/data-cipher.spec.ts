import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type Binding,
  BlindIndexer,
  DataCipher,
  DecryptionError,
  normalizers,
} from './data-cipher.js';

const key = () => randomBytes(32).toString('base64');
const TENANT = '0190f5d6-6d5a-7000-8000-000000000001';
const OTHER_TENANT = '0190f5d6-6d5a-7000-8000-000000000002';
const binding: Binding = {
  table: 'customers',
  column: 'tax_number',
  tenantId: TENANT,
};

const reasonOf = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return (error as DecryptionError).reason;
  }
  return undefined;
};

describe('DataCipher', () => {
  it('round-trips a value in the v1 format, naming its key version', () => {
    const cipher = new DataCipher([key()]);
    const stored = cipher.encrypt('DE 123 456 789', binding);
    const [format, keyId, iv, ciphertext, tag] = stored.split('.');
    expect(format).toBe('v1');
    expect(keyId).toBe(cipher.currentKeyId);
    expect([iv, ciphertext, tag].every(Boolean)).toBe(true);
    expect(stored).not.toContain('DE 123');
    expect(cipher.decrypt(stored, binding)).toBe('DE 123 456 789');
  });

  it('writes a fresh IV every time', () => {
    const cipher = new DataCipher([key()]);
    expect(cipher.encrypt('same', binding)).not.toBe(
      cipher.encrypt('same', binding),
    );
  });

  it('refuses a value moved to another tenant, column or table (the AAD)', () => {
    const cipher = new DataCipher([key()]);
    const stored = cipher.encrypt('secret', binding);
    for (const other of [
      { ...binding, tenantId: OTHER_TENANT },
      { ...binding, tenantId: null },
      { ...binding, column: 'phone' },
      { ...binding, table: 'suppliers' },
    ]) {
      expect(reasonOf(() => cipher.decrypt(stored, other))).toBe(
        'authentication_failed',
      );
    }
  });

  it('refuses a tampered value, an unknown format and an unknown key', () => {
    const cipher = new DataCipher([key()]);
    const stored = cipher.encrypt('secret', binding);
    const parts = stored.split('.');
    const flipped = Buffer.from(parts[3], 'base64url');
    flipped[0] ^= 1;
    parts[3] = flipped.toString('base64url');
    expect(reasonOf(() => cipher.decrypt(parts.join('.'), binding))).toBe(
      'authentication_failed',
    );
    expect(
      reasonOf(() => cipher.decrypt(stored.replace(/^v1/, 'v2'), binding)),
    ).toBe('unknown_format');
    expect(
      reasonOf(() => new DataCipher([key()]).decrypt(stored, binding)),
    ).toBe('unknown_key');
    expect(reasonOf(() => cipher.decrypt('plain text', binding))).toBe(
      'malformed',
    );
  });

  it('opens values under every key, writes with the first', () => {
    const old = key();
    const before = new DataCipher([old]);
    const stored = before.encrypt('secret', binding);
    const rotated = new DataCipher([key(), old]);
    expect(rotated.decrypt(stored, binding)).toBe('secret');
    expect(rotated.isCurrent(stored)).toBe(false);
    expect(rotated.keyIdOf(stored)).toBe(before.currentKeyId);
    expect(rotated.isCurrent(rotated.encrypt('secret', binding))).toBe(true);
  });

  it('refuses short keys, the same key twice, and encrypting without keys', () => {
    expect(() => new DataCipher(['short'])).toThrow(/at least 32/);
    const same = key();
    expect(() => new DataCipher([same, same])).toThrow(/twice/);
    expect(() => new DataCipher([]).encrypt('x', binding)).toThrow(
      /DATA_ENCRYPTION_KEYS is not set/,
    );
  });
});

describe('BlindIndexer', () => {
  it('is deterministic per key, binding and value, and names its key', () => {
    const indexer = new BlindIndexer([key()]);
    const index = indexer.index('de123', binding);
    expect(index).toBe(indexer.index('de123', binding));
    expect(index.startsWith(`${indexer.currentKeyId}.`)).toBe(true);
    expect(index).not.toBe(indexer.index('de124', binding));
    expect(index).not.toBe(
      indexer.index('de123', { ...binding, tenantId: OTHER_TENANT }),
    );
    expect(index).not.toBe(indexer.index('de123', { ...binding, column: 'x' }));
  });

  it("gives every key's index while rotating, and matches any of them", () => {
    const old = key();
    const before = new BlindIndexer([old]);
    const stored = before.index('de123', binding);
    const rotated = new BlindIndexer([key(), old]);
    const all = rotated.indexes('de123', binding);
    expect(all).toHaveLength(2);
    expect(all[1]).toBe(stored);
    expect(rotated.matches(stored, 'de123', binding)).toBe(true);
    expect(rotated.matches(stored, 'de124', binding)).toBe(false);
    expect(rotated.keyIdOf(stored)).toBe(before.currentKeyId);
  });

  it('derives other bytes from the same key string than the cipher', () => {
    const shared = key();
    const cipher = new DataCipher([shared]);
    const indexer = new BlindIndexer([shared]);
    expect(cipher.currentKeyId).not.toBe(indexer.currentKeyId);
  });
});

describe('normalizers', () => {
  it('folds the spellings of one value together', () => {
    expect(normalizers.email('  Ada@Example.COM ')).toBe('ada@example.com');
    expect(normalizers.text('  Ada   LOVELACE ')).toBe('ada lovelace');
    expect(normalizers.exact(' AbC ')).toBe('AbC');
    expect(normalizers.phone('+49 (30) 123-456.78')).toBe('+493012345678');
    expect(normalizers.phone('0049 30 1234567')).toBe('+49301234567');
  });

  it('refuses a phone number without its country code', () => {
    expect(() => normalizers.phone('030 1234567')).toThrow(/country code/);
  });
});
