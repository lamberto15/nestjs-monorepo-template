import { AsyncLocalStorage } from 'node:async_hooks';
import { eq, isNull, or } from 'drizzle-orm';
import { PgDialect, pgTable, uuid } from 'drizzle-orm/pg-core';
import { ClsService, ClsServiceManager } from 'nestjs-cls';
import {
  consolidatedScope,
  TENANT_SCOPE,
  tenantScope,
} from './tenant-scope.js';
import { tenantPredicate } from './tenant-query.js';

const A = '0199a000-0000-7000-8000-00000000000a';
const B = '0199a000-0000-7000-8000-00000000000b';
const rows = pgTable('rows', { tenantId: uuid('tenant_id') });
const dialect = new PgDialect();

describe('tenant query predicates', () => {
  const cls = new ClsService(new AsyncLocalStorage());

  beforeEach(() =>
    vi.spyOn(ClsServiceManager, 'getClsService').mockReturnValue(cls),
  );

  it('adds equality for one ordinary tenant and can include global null rows', async () => {
    await cls.run(async () => {
      cls.set(TENANT_SCOPE, tenantScope(A));
      expect(dialect.sqlToQuery(tenantPredicate(rows.tenantId)!)).toEqual(
        dialect.sqlToQuery(eq(rows.tenantId, A)),
      );
      expect(
        dialect.sqlToQuery(
          tenantPredicate(rows.tenantId, { includeNullRows: true })!,
        ),
      ).toEqual(
        dialect.sqlToQuery(or(eq(rows.tenantId, A), isNull(rows.tenantId))!),
      );
    });
  });

  it('leaves consolidated, bypass and absent scopes to their existing semantics', async () => {
    await cls.run(async () => {
      cls.set(TENANT_SCOPE, consolidatedScope(A, [B]));
      expect(tenantPredicate(rows.tenantId)).toBeUndefined();
      cls.set(TENANT_SCOPE, { tenantId: null, readTenants: [], bypass: true });
      expect(tenantPredicate(rows.tenantId)).toBeUndefined();
      cls.set(TENANT_SCOPE, undefined);
      expect(tenantPredicate(rows.tenantId)).toBeUndefined();
    });
  });
});
