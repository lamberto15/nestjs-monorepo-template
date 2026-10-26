import { and, eq, isNull, or, type AnyColumn, type SQL } from 'drizzle-orm';
import { currentTenantScope } from './tenant-scope.js';

/**
 * An explicit tenant predicate for an ordinary, single-tenant read. RLS
 * remains the security boundary; this lets PostgreSQL use a tenant-leading
 * index. A widened, consolidated or bypass scope gets no extra predicate.
 * `includeNullRows` is for tenant tables whose null rows are global/everywhere.
 */
export function tenantPredicate(
  column: AnyColumn,
  { includeNullRows = false }: { includeNullRows?: boolean } = {},
): SQL | undefined {
  const scope = currentTenantScope();
  if (
    !scope ||
    scope.bypass ||
    !scope.tenantId ||
    scope.readTenants.length !== 1 ||
    scope.readTenants[0] !== scope.tenantId
  ) {
    return undefined;
  }
  const tenant = eq(column, scope.tenantId);
  return includeNullRows ? or(tenant, isNull(column)) : tenant;
}

/** Combine an optional caller predicate with the explicit tenant predicate. */
export const inTenant = (
  column: AnyColumn,
  where?: SQL,
  options?: { includeNullRows?: boolean },
) => and(where, tenantPredicate(column, options));
