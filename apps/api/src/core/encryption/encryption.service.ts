import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { inArray, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { CoreEnv } from '../config/core.env.js';
import { requireTenantId } from '../tenancy/tenant-scope.js';
import {
  type Binding,
  BlindIndexer,
  DataCipher,
  parseEncrypted,
  FORMAT,
} from './data-cipher.js';
import {
  type EncryptedColumn,
  encryptedColumn,
  encryptedColumns,
} from './encrypted-columns.js';

/**
 * Encrypts and decrypts the declared columns (encrypted-columns.ts) with the
 * deployment's keys, bound to their table, column and tenant (docs/encryption.md).
 * Services call it where they write and read the column: the binding needs
 * the tenant, which the current scope gives (a tenant table) or which is
 * none (a global table).
 *
 * ```ts
 * await tx.insert(customers).values({ name, ...this.encryption.seal(customers.taxNumber, taxNumber) });
 * const rows = await db.select().from(customers).where(this.encryption.lookup(customers.taxNumber, taxNumber));
 * const plain = this.encryption.decrypt(customers.taxNumber, rows[0].taxNumber);
 * ```
 */
@Injectable()
export class EncryptionService implements OnModuleInit {
  private readonly logger = new Logger('Encryption');
  private readonly cipher: DataCipher;
  private readonly indexer: BlindIndexer;

  constructor(config: ConfigService<CoreEnv, true>) {
    const data = config.get('DATA_ENCRYPTION_KEYS', { infer: true }) ?? [];
    const index = config.get('BLIND_INDEX_KEYS', { infer: true }) ?? [];
    if (data.some((key) => index.includes(key))) {
      throw new Error(
        'BLIND_INDEX_KEYS and DATA_ENCRYPTION_KEYS share a key: give each its own.',
      );
    }
    this.cipher = new DataCipher(data);
    this.indexer = new BlindIndexer(index);
  }

  /**
   * Boot is refused when a column is declared encrypted (or indexed) and
   * its keys are missing: a write would fail later, or a read find nothing.
   */
  onModuleInit() {
    const columns = encryptedColumns();
    if (columns.length > 0 && !this.cipher.configured) {
      throw new Error(
        `DATA_ENCRYPTION_KEYS is not set, and ${columns.length} column(s) are encrypted (${describe(columns)}): set it (docs/encryption.md).`,
      );
    }
    const indexed = columns.filter((column) => column.blindIndex);
    if (indexed.length > 0 && !this.indexer.configured) {
      throw new Error(
        `BLIND_INDEX_KEYS is not set, and ${indexed.length} column(s) have a blind index (${describe(indexed)}): set it (docs/encryption.md).`,
      );
    }
    if (columns.length > 0) {
      this.logger.log(
        `${columns.length} encrypted column(s), key ${this.cipher.currentKeyId}`,
      );
    }
  }

  /** The key version new values get. */
  get currentKeyId(): string | undefined {
    return this.cipher.currentKeyId;
  }

  /** The key version new blind indexes get. */
  get currentIndexKeyId(): string | undefined {
    return this.indexer.currentKeyId;
  }

  /** The stored form of `plaintext` in `column` (null stays null). */
  encrypt(
    column: PgColumn,
    plaintext: string,
    tenantId?: string | null,
  ): string;
  encrypt(
    column: PgColumn,
    plaintext: string | null | undefined,
    tenantId?: string | null,
  ): string | null;
  encrypt(
    column: PgColumn,
    plaintext: string | null | undefined,
    tenantId?: string | null,
  ): string | null {
    if (plaintext === null || plaintext === undefined) {
      return null;
    }
    return this.cipher.encrypt(plaintext, this.binding(column, tenantId));
  }

  /** The plaintext of a stored value of `column` (null stays null); a DecryptionError when it doesn't open. */
  decrypt(column: PgColumn, stored: string, tenantId?: string | null): string;
  decrypt(
    column: PgColumn,
    stored: string | null | undefined,
    tenantId?: string | null,
  ): string | null;
  decrypt(
    column: PgColumn,
    stored: string | null | undefined,
    tenantId?: string | null,
  ): string | null {
    if (stored === null || stored === undefined) {
      return null;
    }
    return this.cipher.decrypt(stored, this.binding(column, tenantId));
  }

  /** The blind index of `value` under the current key (normalized first). */
  blindIndex(
    column: PgColumn,
    value: string,
    tenantId?: string | null,
  ): string {
    const { normalize } = this.indexOf(column);
    return this.indexer.index(normalize(value), this.binding(column, tenantId));
  }

  /**
   * The condition finding the rows whose `column` holds `value`: its blind
   * index under every configured key, so rows not yet re-indexed after a
   * rotation are found too.
   */
  lookup(column: PgColumn, value: string, tenantId?: string | null): SQL {
    const index = this.indexOf(column);
    return inArray(
      index.column,
      this.indexer.indexes(
        index.normalize(value),
        this.binding(column, tenantId),
      ),
    );
  }

  /**
   * The values to write for `plaintext`: the column's ciphertext and, when
   * it has one, its blind index, by their row properties
   * (`{ taxNumber, taxNumberIndex }`), for an insert or an update.
   */
  seal(
    column: PgColumn,
    plaintext: string | null,
    tenantId?: string | null,
  ): Record<string, string | null> {
    const entry = encryptedColumn(column);
    const values: Record<string, string | null> = {
      [entry.key]: this.encrypt(column, plaintext, tenantId),
    };
    if (entry.blindIndex) {
      values[entry.blindIndex.key] =
        plaintext === null
          ? null
          : this.blindIndex(column, plaintext, tenantId);
    }
    return values;
  }

  /**
   * Whether a stored row needs the re-encryption job: its value isn't in
   * today's format under the current key, or its blind index isn't under
   * the current index key.
   */
  isStale(
    entry: EncryptedColumn,
    stored: string | null,
    storedIndex?: string | null,
  ): boolean {
    if (stored === null) {
      return false;
    }
    if (!this.cipher.isCurrent(stored)) {
      return true;
    }
    return (
      entry.blindIndex !== undefined &&
      this.indexer.keyIdOf(storedIndex ?? '') !== this.indexer.currentKeyId
    );
  }

  /**
   * A stored value (and its index) rewritten under the current keys: what
   * the re-encryption job writes back. A DecryptionError when it doesn't
   * open (a key removed too early, a value moved by hand).
   */
  rewrite(
    entry: EncryptedColumn,
    stored: string,
    tenantId: string | null,
  ): { value: string; index?: string } {
    const plaintext = this.decrypt(entry.column, stored, tenantId);
    return {
      value: this.encrypt(entry.column, plaintext, tenantId),
      index: entry.blindIndex
        ? this.blindIndex(entry.column, plaintext, tenantId)
        : undefined,
    };
  }

  /** The SQL prefix every value under the current key starts with (`v1.<key id>.`). */
  currentPrefix(): string | undefined {
    return this.cipher.currentKeyId
      ? `${FORMAT}.${this.cipher.currentKeyId}.`
      : undefined;
  }

  /** The SQL prefix every blind index under the current key starts with (`<key id>.`). */
  currentIndexPrefix(): string | undefined {
    return this.indexer.currentKeyId
      ? `${this.indexer.currentKeyId}.`
      : undefined;
  }

  /** The key version of a stored value (for logs and metrics), undefined when it isn't one. */
  keyIdOf(stored: string): string | undefined {
    return parseEncrypted(stored)?.keyId;
  }

  private indexOf(column: PgColumn) {
    const entry = encryptedColumn(column);
    if (!entry.blindIndex) {
      throw new Error(
        `${entry.bindingTable}.${entry.bindingColumn} has no blind index: it can't be looked up by value.`,
      );
    }
    return entry.blindIndex;
  }

  private binding(column: PgColumn, tenantId?: string | null): Binding {
    const entry = encryptedColumn(column);
    return {
      table: entry.bindingTable,
      column: entry.bindingColumn,
      tenantId: entry.tenantScoped
        ? (tenantId ??
          requireTenantId(
            `Encrypting ${entry.bindingTable}.${entry.bindingColumn}`,
          ))
        : null,
    };
  }
}

const describe = (columns: readonly EncryptedColumn[]) =>
  columns
    .map((column) => `${column.bindingTable}.${column.bindingColumn}`)
    .join(', ');
