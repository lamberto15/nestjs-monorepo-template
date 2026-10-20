import { pgTable } from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../../src/core/database/columns.js';
import { normalizers } from '../../../src/core/encryption/data-cipher.js';
import {
  blindIndexText,
  encrypted,
  encryptedText,
} from '../../../src/core/encryption/encrypted-columns.js';
import {
  tenantColumn,
  tenantTable,
} from '../../../src/core/tenancy/tenant-scope.js';

/**
 * A test-only tenant table with an encrypted column and its blind index
 * (docs/encryption.md), for encryption.e2e-spec.ts: the template itself
 * declares no encrypted column yet. Importing this file declares it, so
 * only the suites that import it need the keys.
 */
export const testEncryptedRecords = pgTable(
  'test_encrypted_records',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    taxNumber: encryptedText('tax_number'),
    taxNumberIndex: blindIndexText('tax_number_index'),
    ...timestamps(),
  },
  (t) => [...tenantTable('test_encrypted_records', t)],
).enableRLS();

export const TEST_TAX_NUMBER = encrypted(testEncryptedRecords.taxNumber, {
  blindIndex: testEncryptedRecords.taxNumberIndex,
  normalize: normalizers.exact,
});
