import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, count, eq, inArray, type SQL } from 'drizzle-orm';
import { scimPatch } from 'scim-patch';
import { z } from 'zod';
import type { CoreEnv } from '../../../core/config/core.env.js';
import type { Transaction } from '../../../core/database/drizzle.js';
import {
  pgErrorCode,
  UNIQUE_VIOLATION,
} from '../../../core/database/errors.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../../core/database/transactions.js';
import { AccessService } from '../../access/access.service.js';
import { TeamsService } from '../../access/teams.service.js';
import { AuditService } from '../../audit/audit.service.js';
import type { ClientPrincipal } from '../../auth/principal.js';
import { teams, userTeams, users } from '../../iam.tables.js';
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
 * SCIM 2.0 Groups as the tenant's teams (docs/auth.md, "SCIM
 * provisioning"): a group the IdP creates is a top-level team, its
 * members those of the team. Only the teams the SCIM client created (a
 * `scim_groups` row) are its, and only users it provisioned can be their
 * members: an IdP never reaches the teams and members administrators
 * manage. A team grants what roles with team conditions say, so the
 * abilities are dropped on every change, as the access API's are.
 */
@Injectable()
export class ScimGroupsService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly teamsService: TeamsService,
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
      id: { column: scimGroups.teamId, uuid: true },
      displayName: { column: teams.name, caseInsensitive: true },
      externalId: { column: scimGroups.externalId },
    });
    const page = scimPage(query.startIndex, query.count);
    const withMembers = !/(^|,)\s*members\s*(,|$)/i.test(
      query.excludedAttributes ?? '',
    );
    const [rows, [{ total }]] = await Promise.all([
      page.limit
        ? this.select(this.db, where)
            .orderBy(asc(scimGroups.createdAt), asc(scimGroups.teamId))
            .limit(page.limit)
            .offset(page.offset)
        : Promise.resolve([]),
      this.db
        .select({ total: count() })
        .from(scimGroups)
        .innerJoin(teams, eq(teams.id, scimGroups.teamId))
        .where(where),
    ]);
    const members = withMembers
      ? await this.membersOf(
          this.db,
          rows.map((row) => row.teamId),
        )
      : undefined;
    return {
      schemas: [SCIM_SCHEMA.list],
      totalResults: total,
      startIndex: page.startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map((row) =>
        this.resource(row, members?.get(row.teamId)),
      ),
    };
  }

  async get(id: string) {
    const row = await this.find(this.db, id);
    const members = await this.membersOf(this.db, [id]);
    return this.resource(row, members.get(id) ?? []);
  }

  async create(actor: ClientPrincipal, input: ScimGroupInput, ip?: string) {
    const teamId = await this.unique(() =>
      inTransaction(this.txHost, async (tx) => {
        if (input.externalId) {
          await this.assertExternalIdFree(tx, input.externalId);
        }
        const [team] = await tx
          .insert(teams)
          .values({ name: input.displayName, parentId: null })
          .returning();
        await this.teamsService.tree.add(tx, team.id, null);
        await tx.insert(scimGroups).values({
          teamId: team.id,
          externalId: input.externalId ?? null,
        });
        const members = await this.setMembers(tx, team.id, memberIds(input));
        await this.audit.record(
          actor,
          {
            action: 'scim.group-created',
            targetType: 'team',
            targetId: team.id,
            details: {
              name: team.name,
              externalId: input.externalId ?? null,
              members,
            },
            ip,
          },
          tx,
        );
        return team.id;
      }),
    );
    this.access.invalidate();
    return this.get(teamId);
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
          .update(teams)
          .set({ name: input.displayName })
          .where(eq(teams.id, id));
        await tx
          .update(scimGroups)
          .set({ externalId: input.externalId ?? null, updatedAt: new Date() })
          .where(eq(scimGroups.teamId, id));
        const members = await this.setMembers(tx, id, memberIds(input));
        await this.audit.record(
          actor,
          {
            action: 'scim.group-updated',
            targetType: 'team',
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

  /** DELETE: the team goes, with its members' places in it (not the members). */
  async remove(actor: ClientPrincipal, id: string, ip?: string) {
    await inTransaction(this.txHost, async (tx) => {
      const before = await this.find(tx, id);
      const [{ children }] = await tx
        .select({ children: count() })
        .from(teams)
        .where(eq(teams.parentId, id));
      if (children > 0) {
        // An administrator put teams under it: theirs to move first.
        throw new ScimException(
          409,
          'Teams were put under this group: an administrator moves them first.',
        );
      }
      await tx.delete(userTeams).where(eq(userTeams.teamId, id));
      await tx.delete(scimGroups).where(eq(scimGroups.teamId, id));
      await tx.delete(teams).where(eq(teams.id, id));
      await this.audit.record(
        actor,
        {
          action: 'scim.group-deleted',
          targetType: 'team',
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
   * The team's members become `ids`: only users the SCIM client
   * provisioned (any other id is a 400, never a member of the tenant
   * added through a group). Returns what changed, for the audit entry.
   */
  private async setMembers(tx: Transaction, teamId: string, ids: string[]) {
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
    const current = (
      await tx
        .select({ userId: userTeams.userId })
        .from(userTeams)
        .where(eq(userTeams.teamId, teamId))
    ).map((row) => row.userId);
    const added = wanted.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !wanted.includes(id));
    if (removed.length) {
      await tx
        .delete(userTeams)
        .where(
          and(eq(userTeams.teamId, teamId), inArray(userTeams.userId, removed)),
        );
    }
    if (added.length) {
      await tx
        .insert(userTeams)
        .values(added.map((userId) => ({ userId, teamId })));
    }
    return { added, removed };
  }

  private async membersOf(
    db: ReturnType<typeof database> | Transaction,
    teamIds: string[],
  ) {
    const byTeam = new Map<string, { value: string; display: string }[]>();
    if (!teamIds.length) {
      return byTeam;
    }
    const rows = await db
      .select({
        teamId: userTeams.teamId,
        userId: userTeams.userId,
        email: users.email,
      })
      .from(userTeams)
      .innerJoin(users, eq(users.id, userTeams.userId))
      .where(inArray(userTeams.teamId, teamIds))
      .orderBy(asc(users.email));
    for (const row of rows) {
      const list = byTeam.get(row.teamId) ?? [];
      list.push({ value: row.userId, display: row.email });
      byTeam.set(row.teamId, list);
    }
    return byTeam;
  }

  private async assertExternalIdFree(tx: Transaction, externalId: string) {
    const [taken] = await tx
      .select({ teamId: scimGroups.teamId })
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
          'Another group has this externalId.',
          'uniqueness',
        );
      }
      throw error;
    }
  }

  private select(db: ReturnType<typeof database> | Transaction, where?: SQL) {
    return db
      .select({
        teamId: scimGroups.teamId,
        externalId: scimGroups.externalId,
        name: teams.name,
        createdAt: scimGroups.createdAt,
        updatedAt: scimGroups.updatedAt,
      })
      .from(scimGroups)
      .innerJoin(teams, eq(teams.id, scimGroups.teamId))
      .where(where);
  }

  private async find(
    db: ReturnType<typeof database> | Transaction,
    id: string,
  ) {
    if (!z.uuid().safeParse(id).success) {
      throw new ScimException(404, `Group ${id} not found.`);
    }
    const [row] = await this.select(db, eq(scimGroups.teamId, id));
    if (!row) {
      throw new ScimException(404, `Group ${id} not found.`);
    }
    return row;
  }

  private resource(
    row: {
      teamId: string;
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
      id: row.teamId,
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
        location: `${base}/v1/scim/Groups/${row.teamId}`,
      },
    };
  }
}

const memberIds = (input: ScimGroupInput) =>
  (input.members ?? []).map((member) => member.value);
