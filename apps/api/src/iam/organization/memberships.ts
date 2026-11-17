import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import {
  organizationalUnitClosure,
  organizationalUnitMemberships,
  type UnitRole,
} from './organization.tables.js';

/** Which of a user's units: `below` adds every unit under them, `role` keeps those they hold that role in. */
export interface UnitsOfOptions {
  below?: boolean;
  role?: UnitRole;
}

/** Builds subqueries with no connection: they run inside the caller's query. */
const subquery = new QueryBuilder();

/** A membership current at `at`: started (`validFrom`), and not ended (`validTo`, exclusive). */
export const currentMembership = (at = new Date()) =>
  and(
    lte(organizationalUnitMemberships.validFrom, at),
    or(
      isNull(organizationalUnitMemberships.validTo),
      gt(organizationalUnitMemberships.validTo, at),
    ),
  );

/**
 * The ids of the units `userId` is a current member of at `at` (from
 * `validFrom`, before `validTo`), as a subquery: `inArray(column,
 * unitIdsOf(id))`. Membership of a unit never implies its parent. Read in
 * the caller's transaction, so row-level security keeps it to the tenant.
 */
export function unitIdsOf(
  userId: string,
  options: UnitsOfOptions = {},
  at = new Date(),
) {
  const member = organizationalUnitMemberships;
  const current = and(
    eq(member.userId, userId),
    currentMembership(at),
    options.role ? eq(member.role, options.role) : undefined,
  );
  if (!options.below) {
    return subquery.select({ id: member.unitId }).from(member).where(current);
  }
  const tree = organizationalUnitClosure;
  return subquery
    .select({ id: tree.descendantId })
    .from(tree)
    .innerJoin(member, eq(member.unitId, tree.ancestorId))
    .where(current);
}
