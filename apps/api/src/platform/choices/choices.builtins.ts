import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, eq, ilike } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { escapeLike } from '../../core/http/list-query.js';
import { AccessService } from '../../iam/access/access.service.js';
import { OrganizationalUnitsService } from '../../iam/access/organizational-units.service.js';
import { currentMembership } from '../../iam/access/permissions.js';
import {
  organizationalUnitMemberships,
  organizationalUnits,
  users,
} from '../../iam/iam.tables.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import {
  type ChoiceItem,
  type ChoiceProvider,
  ChoicesRegistry,
  paramFits,
} from './choices.registry.js';

/**
 * The providers the template ships with, and the example set that uses
 * them (docs/choices.md): pick a unit, then one of its members. Both read
 * through the request's transaction, behind row-level security, so a
 * tenant never sees another's rows.
 */
@Injectable()
export class ChoicesBuiltins {
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly access: AccessService,
    private readonly units: OrganizationalUnitsService,
    registry: ChoicesRegistry,
  ) {
    registry.provider(this.unitsProvider());
    registry.provider(this.unitMembersProvider());
    registry.set({
      key: 'unit-member',
      label: 'A unit, then one of its members',
      fields: {
        unit: { provider: 'organizational-units' },
        member: { provider: 'unit-members', params: { unitId: 'unit' } },
      },
    });
  }

  /** The tenant's units, as every user may see them (the units lookup, docs/permissions.md). */
  private unitsProvider(): ChoiceProvider {
    const find = (
      where: ReturnType<typeof and>,
      limit: number,
    ): Promise<ChoiceItem[]> =>
      this.db
        .select({
          value: organizationalUnits.id,
          label: organizationalUnits.name,
        })
        .from(organizationalUnits)
        .where(where)
        .orderBy(asc(organizationalUnits.name), asc(organizationalUnits.id))
        .limit(limit);
    return {
      key: 'organizational-units',
      label: 'Organizational units',
      params: {},
      mayUse: async (principal) => principal.kind === 'user',
      options: ({ q, limit }) =>
        find(
          q ? ilike(organizationalUnits.name, `%${escapeLike(q)}%`) : undefined,
          limit,
        ),
      has: async ({ value }) =>
        paramFits('uuid', value) &&
        (await find(eq(organizationalUnits.id, value), 1)).length > 0,
    };
  }

  /**
   * The current members of a unit, by name. Seen by whoever manages users
   * and by the unit's own members; for anyone else the unit has no members
   * to choose from (an empty answer, as for a unit that does not exist, so
   * it never says which units have whom).
   */
  private unitMembersProvider(): ChoiceProvider {
    const may = async (principal: RequestPrincipal, unitId: string) =>
      principal.kind === 'user' &&
      ((await this.access.can(principal, 'manageUsers', 'Access')) ||
        (await this.units.unitsOf(principal.id)).includes(unitId));
    const find = (
      unitId: string,
      limit: number,
      extra?: ReturnType<typeof and>,
    ) =>
      this.db
        .select({ value: users.id, label: users.name })
        .from(organizationalUnitMemberships)
        .innerJoin(users, eq(users.id, organizationalUnitMemberships.userId))
        .where(
          and(
            eq(organizationalUnitMemberships.unitId, unitId),
            currentMembership(),
            extra,
          ),
        )
        .orderBy(asc(users.name), asc(users.id))
        .limit(limit);
    return {
      key: 'unit-members',
      label: 'Members of an organizational unit',
      params: { unitId: 'uuid' },
      mayUse: async (principal) => principal.kind === 'user',
      options: async ({ principal, params, q, limit }) =>
        (await may(principal, params.unitId!))
          ? find(
              params.unitId!,
              limit,
              q ? ilike(users.name, `%${escapeLike(q)}%`) : undefined,
            )
          : [],
      has: async ({ principal, params, value }) =>
        paramFits('uuid', value) &&
        (await may(principal, params.unitId!)) &&
        (await find(params.unitId!, 1, eq(users.id, value))).length > 0,
    };
  }
}
