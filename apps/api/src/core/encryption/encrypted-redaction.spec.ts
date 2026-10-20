import { pgTable, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { assertNoEncryptedColumns } from '../../platform/data-transfer/data-transfer.registry.js';
import { normalizers } from './data-cipher.js';
import {
  blindIndexText,
  encrypted,
  encryptedProperties,
  encryptedText,
  withoutEncrypted,
} from './encrypted-columns.js';

const people = pgTable('spec_redaction_people', {
  id: uuid('id').primaryKey(),
  nationalId: encryptedText('national_id'),
  nationalIdIndex: blindIndexText('national_id_index'),
});
encrypted(people.nationalId, {
  blindIndex: people.nationalIdIndex,
  normalize: normalizers.exact,
});

describe('where an encrypted column must not appear', () => {
  it('knows the value and the blind index properties', () => {
    const names = encryptedProperties();
    expect(names.has('nationalId')).toBe(true);
    expect(names.has('nationalIdIndex')).toBe(true);
    expect(names.has('id')).toBe(false);
  });

  it('strips them at any depth, leaving other values and non-plain objects', () => {
    const when = new Date();
    expect(
      withoutEncrypted({
        name: 'Ada',
        nationalId: 'v1.k.iv.ct.tag',
        nationalIdIndex: 'k.mac',
        when,
        nested: { nationalId: 'x', kept: 1 },
        list: [{ nationalId: 'y', ok: true }],
      }),
    ).toEqual({
      name: 'Ada',
      when,
      nested: { kept: 1 },
      list: [{ ok: true }],
    });
  });

  it('refuses an export column on an encrypted property unless it decrypts', () => {
    expect(() =>
      assertNoEncryptedColumns('people', [
        { key: 'name' },
        { key: 'nationalId' },
      ]),
    ).toThrow(/nationalId is an encrypted column/);
    expect(() =>
      assertNoEncryptedColumns('people', [
        { key: 'nationalId', value: () => 'decrypted for an allowed reader' },
      ]),
    ).not.toThrow();
  });
});
