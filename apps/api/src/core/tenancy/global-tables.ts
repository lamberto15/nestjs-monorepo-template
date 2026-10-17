/**
 * The global tables that carry a `tenant_id` without row-level security
 * (docs/tenancy.md, "Global tables"): they are read before a request has a
 * tenant, to find it.
 *
 * - `memberships`: which tenants a user belongs to (a sign-in picks the
 *   session's tenant from them, the tenant list and the switch read them);
 *   what a membership grants (its roles) is in tenant tables.
 * - `api_keys`: a key is looked up by its id before its client's tenant is
 *   known; the client itself is a tenant table.
 *
 * Code reading them on behalf of a tenant filters by `tenant_id` itself.
 * Every other table with a `tenant_id` must have its wall, which the role
 * bootstrap checks on every migrate (core/database/roles.ts).
 */
export const GLOBAL_TABLES_WITH_TENANT: readonly string[] = [
  'memberships',
  'api_keys',
];
