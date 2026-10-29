import { randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { getColumnTable, getTableName } from 'drizzle-orm';
import { PgDialect, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { CoreEnv } from '../config/core.env.js';
import { normalizers } from './data-cipher.js';
import {
  blindIndexText,
  encrypted,
  encryptedColumn,
  encryptedColumnNamed,
  encryptedColumns,
  encryptedText,
} from './encrypted-columns.js';
import { EncryptionService } from './encryption.service.js';
import { logRedaction } from '../logging/redaction.js';

const customers = pgTable('spec_customers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  taxNumber: encryptedText('tax_number'),
  taxNumberIndex: blindIndexText('tax_number_index'),
  note: text('note'),
});
const settings = pgTable('spec_settings', {
  id: uuid('id').primaryKey(),
  apiSecret: encryptedText('api_secret'),
});
encrypted(customers.taxNumber, {
  blindIndex: customers.taxNumberIndex,
  normalize: normalizers.exact,
});
encrypted(settings.apiSecret);

const TENANT = '0190f5d6-6d5a-7000-8000-000000000001';
const OTHER = '0190f5d6-6d5a-7000-8000-000000000002';
const key = () => randomBytes(32).toString('base64');

const service = (env: Partial<CoreEnv>) =>
  new EncryptionService({
    get: (name: keyof CoreEnv) => env[name],
  } as unknown as ConfigService<CoreEnv, true>);

describe('the encrypted column registry', () => {
  it('lists the declared columns with their binding and tenant', () => {
    const entry = encryptedColumn(customers.taxNumber);
    expect(entry).toMatchObject({
      key: 'taxNumber',
      bindingTable: 'spec_customers',
      bindingColumn: 'tax_number',
      tenantScoped: true,
      blindIndex: { key: 'taxNumberIndex' },
    });
    expect(encryptedColumn(settings.apiSecret).tenantScoped).toBe(false);
    expect(encryptedColumnNamed('spec_settings.api_secret')?.column).toBe(
      settings.apiSecret,
    );
    expect(
      encryptedColumns().map((c) => getTableName(getColumnTable(c))),
    ).toEqual(['spec_customers', 'spec_settings']);
  });

  it('masks the columns by name in the logs', () => {
    expect(logRedaction.paths()).toEqual(
      expect.arrayContaining(['taxNumber', 'apiSecret']),
    );
  });

  it('refuses a second declaration, a non-text column, an index without a normalizer', () => {
    expect(() => encrypted(customers.taxNumber)).toThrow(/twice/);
    expect(() => encrypted(customers.tenantId)).toThrow(/is text/);
    expect(() =>
      encrypted(customers.note, { blindIndex: customers.taxNumberIndex }),
    ).toThrow(/normalizer/);
    expect(() => encryptedColumn(customers.note)).toThrow(/not declared/);
  });
});

describe('EncryptionService', () => {
  it('refuses to boot without keys once a column is encrypted or indexed', () => {
    expect(() => service({}).onModuleInit()).toThrow(
      /DATA_ENCRYPTION_KEYS is not set.*spec_customers\.tax_number/,
    );
    expect(() =>
      service({ DATA_ENCRYPTION_KEYS: [key()] }).onModuleInit(),
    ).toThrow(/BLIND_INDEX_KEYS is not set/);
    expect(() =>
      service({
        DATA_ENCRYPTION_KEYS: [key()],
        BLIND_INDEX_KEYS: [key()],
      }).onModuleInit(),
    ).not.toThrow();
  });

  it('refuses the same key for data and indexes', () => {
    const shared = key();
    expect(() =>
      service({ DATA_ENCRYPTION_KEYS: [shared], BLIND_INDEX_KEYS: [shared] }),
    ).toThrow(/share a key/);
  });

  it('seals a value with its index, binds it to the tenant, and finds it by value', () => {
    const encryption = service({
      DATA_ENCRYPTION_KEYS: [key()],
      BLIND_INDEX_KEYS: [key()],
    });
    const sealed = encryption.seal(customers.taxNumber, ' DE123 ', TENANT);
    expect(Object.keys(sealed)).toEqual(['taxNumber', 'taxNumberIndex']);
    expect(
      encryption.decrypt(customers.taxNumber, sealed.taxNumber, TENANT),
    ).toBe(' DE123 ');
    expect(() =>
      encryption.decrypt(customers.taxNumber, sealed.taxNumber, OTHER),
    ).toThrow(/authentication failed/);
    // Normalized (exact: trimmed) before indexing.
    expect(sealed.taxNumberIndex).toBe(
      encryption.blindIndex(customers.taxNumber, 'DE123', TENANT),
    );
    const condition = new PgDialect().sqlToQuery(
      encryption.lookup(customers.taxNumber, 'DE123', TENANT),
    );
    expect(condition.sql).toContain('"tax_number_index" in');
    expect(condition.params).toEqual([sealed.taxNumberIndex]);
    expect(encryption.seal(customers.taxNumber, null, TENANT)).toEqual({
      taxNumber: null,
      taxNumberIndex: null,
    });
  });

  it('needs the tenant for a tenant table, none for a global one', () => {
    const encryption = service({
      DATA_ENCRYPTION_KEYS: [key()],
      BLIND_INDEX_KEYS: [key()],
    });
    expect(() => encryption.encrypt(customers.taxNumber, 'x')).toThrow();
    const stored = encryption.encrypt(settings.apiSecret, 'x');
    expect(encryption.decrypt(settings.apiSecret, stored)).toBe('x');
    expect(() => encryption.lookup(settings.apiSecret, 'x')).toThrow(
      /no blind index/,
    );
  });

  it('knows a stale row and rewrites it under the current keys', () => {
    const [oldData, oldIndex] = [key(), key()];
    const before = service({
      DATA_ENCRYPTION_KEYS: [oldData],
      BLIND_INDEX_KEYS: [oldIndex],
    });
    const sealed = before.seal(customers.taxNumber, 'DE123', TENANT);
    const entry = encryptedColumn(customers.taxNumber);
    expect(before.isStale(entry, sealed.taxNumber, sealed.taxNumberIndex)).toBe(
      false,
    );

    const afterData = service({
      DATA_ENCRYPTION_KEYS: [key(), oldData],
      BLIND_INDEX_KEYS: [oldIndex],
    });
    expect(
      afterData.isStale(entry, sealed.taxNumber, sealed.taxNumberIndex),
    ).toBe(true);
    const afterIndex = service({
      DATA_ENCRYPTION_KEYS: [oldData],
      BLIND_INDEX_KEYS: [key(), oldIndex],
    });
    expect(
      afterIndex.isStale(entry, sealed.taxNumber, sealed.taxNumberIndex),
    ).toBe(true);

    const rewritten = afterData.rewrite(entry, sealed.taxNumber, TENANT);
    expect(afterData.keyIdOf(rewritten.value)).toBe(afterData.currentKeyId);
    expect(rewritten.value.startsWith(afterData.currentPrefix()!)).toBe(true);
    expect(rewritten.index?.startsWith(afterData.currentIndexPrefix()!)).toBe(
      true,
    );
    expect(
      afterData.decrypt(customers.taxNumber, rewritten.value, TENANT),
    ).toBe('DE123');
    expect(afterData.isStale(entry, rewritten.value, rewritten.index)).toBe(
      false,
    );
    expect(afterData.isStale(entry, null)).toBe(false);
  });
});
