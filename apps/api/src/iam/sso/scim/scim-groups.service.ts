import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, count, eq, inArray, type SQL } from 'drizzle-orm';
import { scimPatch } from 'scim-patch';
import { z } from 'zod';
import type { CoreEnv } from '../../../core/config/core.env.js';
import type { Transaction } from '../../../core/database/drizzle.js';
import {
  FOREIGN_KEY_VIOLATION,
  pgErrorCode,
  UNIQUE_VIOLATION,
} from '../../../core/database/errors.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../../core/database/transactions.js';
import { AccessService } from '../../access/access.service.js';
import { OrganizationalUnitsService } from '../../access/organizational-units.service.js';
import { currentMembership } from '../../access/permissions.js';
import { AuditService } from '../../audit/audit.service.js';
import type { ClientPrincipal } from '../../auth/principal.js';
import {
  organizationalUnitMemberships,
  organizationalUnits,
  users,
} from '../../iam.tables.js';
import { scimGroups } from '../sso.tables.js';
import { SCIM_SCHEMA, ScimException } from './scim-error.filter.js';
import { scimFilter, scimPage } from './scim-filter.js';
import {
  patchError,
  patchOperations,
  ScimUsersService,
} from './scim-users.service.js';

/** A SCIM Group as an IdP writes it (RFC 7643 §4.2): its name, and members by user id. */
export const scimGroupSchema = z.looseObject({
  schemas: z.array(z.string()).optional(),
  displayName: z.string().trim().min(1).max(200),
  externalId: z.string().max(512).nullish(),
  members: z
    .array(z.looseObject({ value: z.string().max(100) }))
    .max(10_000)
    .nullish(),
});
export type ScimGroupInput = z.infer<typeof scimGroupSchema>;

/**
 * SCIM 2.0 Groups as the tenant's organizational units (docs/auth.md,
 * "SCIM provisioning"): a group the IdP creates is a top-level unit of type
 * `team`, its members the unit's current members. Only the units the SCIM
 * client created (a `scim_groups` row) are its, and only users it
 * provisioned can be their members: an IdP never reaches the units and
 * members administrators manage. A unit grants what roles with unit
 * conditions say, so the abilities are dropped on every change, as the
 * access API's are. A member removed has their membership ended (kept).
 */
@Injectable()
export class ScimGroupsService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly units: OrganizationalUnitsService,
    private readonly scimUsers: ScimUsersService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly config: ConfigService<CoreEnv, true>,
  ) {}

  private get db() {
    return database(this.txHost);
  }

  async list(query: {
    filter?: string;
    startIndex?: number;
    count?: number;
    excludedAttributes?: string;
  }) {
    const where = scimFilter(query.filter, {
      id: { column: scimGroups.unitId, uuid: true },
      displayName: { column: organizationalUnits.name, caseInsensitive: true },
      externalId: { column: scimGroups.externalId },
    });
    const page = scimPage(query.startIndex, query.count);
    const withMembers = !/(^|,)\s*members\s*(,|$)/i.test(
      query.excludedAttributes ?? '',
    );
    const [rows, [{ total }]] = await Promise.all([
      page.limit
        ? this.select(this.db, where)
            .orderBy(asc(scimGroups.createdAt), asc(scimGroups.unitId))
            .limit(page.limit)
            .offset(page.offset)
        : Promise.resolve([]),
      this.db
        .select({ total: count() })
        .from(scimGroups)
        .innerJoin(
          organizationalUnits,
          eq(organizationalUnits.id, scimGroups.unitId),
        )
        .where(where),
    ]);
    const members = withMembers
      ? await this.membersOf(
          this.db,
          rows.map((row) => row.unitId),
        )
      : undefined;
    return {
      schemas: [SCIM_SCHEMA.list],
      totalResults: total,
      startIndex: page.startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map((row) =>
        this.resource(row, members?.get(row.unitId)),
      ),
    };
  }

  async get(id: string) {
    const row = await this.find(this.db, id);
    const members = await this.membersOf(this.db, [id]);
    return this.resource(row, members.get(id) ?? []);
  }

  async create(actor: ClientPrincipal, input: ScimGroupInput, ip?: string) {
    const unitId = await this.unique(() =>
      inTransaction(this.txHost, async (tx) => {
        if (input.externalId) {
          await this.assertExternalIdFree(tx, input.externalId);
        }
        const [unit] = await tx
          .insert(organizationalUnits)
          .values({ type: 'team', name: input.displayName, parentId: null })
          .returning();
        await this.units.tree.add(tx, unit.id, null);
        await tx.insert(scimGroups).values({
          unitId: unit.id,
          externalId: input.externalId ?? null,
        });
        const members = await this.setMembers(tx, unit.id, memberIds(input));
        await this.audit.record(
          actor,
          {
            action: 'scim.group-created',
            targetType: 'organizationalUnit',
            targetId: unit.id,
            details: {
              name: unit.name,
              externalId: input.externalId ?? null,
              members,
            },
            ip,
          },
          tx,
        );
        return unit.id;
      }),
    );
    this.access.invalidate();
    return this.get(unitId);
  }

  /** PUT: its name, externalId and members are what the IdP sent. */
  async replace(
    actor: ClientPrincipal,
    id: string,
    input: ScimGroupInput,
    ip?: string,
  ) {
    await this.unique(() =>
      inTransaction(this.txHost, async (tx) => {
        const before = await this.find(tx, id);
        if (input.externalId && input.externalId !== before.externalId) {
          await this.assertExternalIdFree(tx, input.externalId);
        }
        await tx
          .update(organizationalUnits)
          .set({ name: input.displayName })
          .where(eq(organizationalUnits.id, id));
        await tx
          .update(scimGroups)
          .set({ externalId: input.externalId ?? null, updatedAt: new Date() })
          .where(eq(scimGroups.unitId, id));
        const members = await this.setMembers(tx, id, memberIds(input));
        await this.audit.record(
          actor,
          {
            action: 'scim.group-updated',
            targetType: 'organizationalUnit',
            targetId: id,
            details: {
              ...(before.name !== input.displayName && {
                name: { from: before.name, to: input.displayName },
              }),
              members,
            },
            ip,
          },
          tx,
        );
      }),
    );
    this.access.invalidate();
    return this.get(id);
  }

  /** PATCH: scim-patch applies the operations (members added or removed by filter) to the group as answered. */
  async patch(actor: ClientPrincipal, id: string, body: unknown, ip?: string) {
    const operations = patchOperations(body);
    const current = await this.get(id);
    let patched: unknown;
    try {
      patched = scimPatch(
        current as unknown as Parameters<typeof scimPatch>[0],
        operations,
        { mutateDocument: false, treatMissingAsAdd: true },
      );
    } catch (error) {
      throw patchError(error);
    }
    const parsed = scimGroupSchema.safeParse(patched);
    if (!parsed.success) {
      throw new ScimException(
        400,
        `The patched group is invalid: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
        'invalidValue',
      );
    }
    return this.replace(actor, id, parsed.data, ip);
  }

  /** DELETE: the unit goes, with its memberships (not the members). */
  async remove(actor: ClientPrincipal, id: string, ip?: string) {
    await inTransaction(this.txHost, async (tx) => {
      const before = await this.find(tx, id);
      const [{ children }] = await tx
        .select({ children: count() })
        .from(organizationalUnits)
        .where(eq(organizationalUnits.parentId, id));
      if (children > 0) {
        // An administrator put units under it: theirs to move first.
        throw new ScimException(
          409,
          'Units were put under this group: an administrator moves them first.',
        );
      }
      await tx
        .delete(organizationalUnitMemberships)
        .where(eq(organizationalUnitMemberships.unitId, id));
      await tx.delete(scimGroups).where(eq(scimGroups.unitId, id));
      await tx
        .delete(organizationalUnits)
        .where(eq(organizationalUnits.id, id))
        .catch((error: unknown) => {
          // Records or saved views of the unit: no cascade.
          throw pgErrorCode(error) === FOREIGN_KEY_VIOLATION
            ? new ScimException(
                409,
                'Records or saved views belong to this group: an administrator moves them first.',
              )
            : error;
        });
      await this.audit.record(
        actor,
        {
          action: 'scim.group-deleted',
          targetType: 'organizationalUnit',
          targetId: id,
          details: { name: before.name, externalId: before.externalId },
          ip,
        },
        tx,
      );
    });
    this.access.invalidate();
  }

  /**
   * The unit's current members become `ids`: only users the SCIM client
   * provisioned (any other id is a 400, never a member of the tenant
   * added through a group). Returns what changed, for the audit entry.
   */
  private async setMembers(tx: Transaction, unitId: string, ids: string[]) {
    const wanted = [...new Set(ids)];
    const valid = wanted.filter((id) => z.uuid().safeParse(id).success);
    const provisioned = await this.scimUsers.provisioned(tx, valid);
    if (provisioned.length !== wanted.length) {
      throw new ScimException(
        400,
        'A member isn’t a user provisioned over SCIM.',
        'invalidValue',
      );
    }
    return this.units.setMembers(tx, unitId, wanted);
  }

  private async membersOf(
    db: ReturnType<typeof database> | Transaction,
    unitIds: string[],
  ) {
    const byUnit = new Map<string, { value: string; display: string }[]>();
    if (!unitIds.length) {
      return byUnit;
    }
    const member = organizationalUnitMemberships;
    const rows = await db
      .select({
        unitId: member.unitId,
        userId: member.userId,
        email: users.email,
      })
      .from(member)
      .innerJoin(users, eq(users.id, member.userId))
      .where(and(inArray(member.unitId, unitIds), currentMembership()))
      .orderBy(asc(users.email));
    for (const row of rows) {
      const list = byUnit.get(row.unitId) ?? [];
      list.push({ value: row.userId, display: row.email });
      byUnit.set(row.unitId, list);
    }
    return byUnit;
  }

  private async assertExternalIdFree(tx: Transaction, externalId: string) {
    const [taken] = await tx
      .select({ unitId: scimGroups.unitId })
      .from(scimGroups)
      .where(eq(scimGroups.externalId, externalId));
    if (taken) {
      throw new ScimException(
        409,
        'Another group has this externalId.',
        'uniqueness',
      );
    }
  }

  private async unique<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (pgErrorCode(error) === UNIQUE_VIOLATION) {
        throw new ScimException(
          409,
          constraintOf(error) === 'organizational_units_sibling_name_idx'
            ? 'A top-level unit already has this displayName (any case).'
            : 'Another group has this externalId.',
          'uniqueness',
        );
      }
      throw error;
    }
  }

  private select(db: ReturnType<typeof database> | Transaction, where?: SQL) {
    return db
      .select({
        unitId: scimGroups.unitId,
        externalId: scimGroups.externalId,
        name: organizationalUnits.name,
        createdAt: scimGroups.createdAt,
        updatedAt: scimGroups.updatedAt,
      })
      .from(scimGroups)
      .innerJoin(
        organizationalUnits,
        eq(organizationalUnits.id, scimGroups.unitId),
      )
      .where(where);
  }

  private async find(
    db: ReturnType<typeof database> | Transaction,
    id: string,
  ) {
    if (!z.uuid().safeParse(id).success) {
      throw new ScimException(404, `Group ${id} not found.`);
    }
    const [row] = await this.select(db, eq(scimGroups.unitId, id));
    if (!row) {
      throw new ScimException(404, `Group ${id} not found.`);
    }
    return row;
  }

  private resource(
    row: {
      unitId: string;
      externalId: string | null;
      name: string;
      createdAt: Date;
      updatedAt: Date;
    },
    members?: { value: string; display: string }[],
  ) {
    const base = `${this.config.get('APP_URL', { infer: true })}`;
    return {
      schemas: [SCIM_SCHEMA.group],
      id: row.unitId,
      ...(row.externalId !== null && { externalId: row.externalId }),
      displayName: row.name,
      ...(members && {
        members: members.map((member) => ({
          ...member,
          $ref: `${base}/v1/scim/Users/${member.value}`,
        })),
      }),
      meta: {
        resourceType: 'Group',
        created: row.createdAt.toISOString(),
        lastModified: row.updatedAt.toISOString(),
        location: `${base}/v1/scim/Groups/${row.unitId}`,
      },
    };
  }
}

const memberIds = (input: ScimGroupInput) =>
  (input.members ?? []).map((member) => member.value);

/** The constraint a PostgreSQL error names (on the error, or the `cause` Drizzle wraps it in). */
const constraintOf = (error: unknown): string | undefined =>
  (error as { constraint?: string })?.constraint ??
  (error as { cause?: { constraint?: string } })?.cause?.constraint;
