import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { StorageDisk } from '@nestjs/storage';
import { and, eq, like, min, sql } from 'drizzle-orm';
import type { Transaction } from '../core/database/drizzle.js';
import { NotesService } from '../features/notes/notes.service.js';
import { AccessAdminService } from '../iam/access/access-admin.service.js';
import { AccessService } from '../iam/access/access.service.js';
import { TeamsService } from '../iam/access/teams.service.js';
import { SingleTenant } from '../iam/access/single-tenant.js';
import { SystemContext } from '../iam/access/system-context.js';
import { AuditService } from '../iam/audit/audit.service.js';
import type { SystemPrincipal } from '../iam/auth/principal.js';
import { UsersRepository } from '../iam/auth/users.repository.js';
import { roles, users } from '../iam/iam.tables.js';
import { tenants } from '../core/tenancy/tenancy.tables.js';
import { tenantFileKey } from '../platform/storage/storage.config.js';
import {
  ADMINISTRATOR_ROLE,
  TenantsService,
} from '../iam/access/tenants.service.js';
import { AttachmentsService } from '../platform/attachments/attachments.service.js';
import { CommentsService } from '../platform/comments/comments.service.js';
import { TagsService } from '../platform/tags/tags.service.js';
import { tags as tagsTable } from '../platform/tags/tags.tables.js';
import {
  DEMO_EMAIL_DOMAIN,
  DEMO_NOTES,
  DEMO_TEAMS,
  DEMO_TAGS,
  DEMO_TENANT,
  DEMO_USERS,
  type DemoNote,
} from './demo-data.js';
import {
  DemoSeedRefused,
  isDevDatabase,
  markerRefusal,
  nodeEnvRefusal,
} from './demo-guard.js';
import { DEMO_SEED_JOB } from './demo.jobs.js';

/** A demo user's sign-in, shown once: only its hash is kept. */
export interface DemoCredentials {
  email: string;
  name: string;
  roles: string[];
  password: string;
}

export type DemoSeedResult =
  | {
      seeded: true;
      tenant: string;
      /** TENANCY=single: the seed filled the operators' tenant, the only one. */
      operators: boolean;
      users: DemoCredentials[];
      notes: number;
    }
  | { seeded: false; since: Date };

/** A demo user's address: `maya.patel@demo.example.com`. */
const demoEmail = (name: string) =>
  `${name.toLowerCase().replace(/\s+/g, '.')}@${DEMO_EMAIL_DOMAIN}`;

/**
 * The demo data (demo-data.ts), written through the services an
 * administrator's requests go through, as the system principal
 * `system:demo-seed` (DEMO_SEED_JOB), in a tenant of its own: every write
 * has its audit entry with the seed as the actor, in the demo tenant's
 * log, and the job's declared permissions are checked where a controller
 * would check them (`@Can()`), and by the services themselves (granting
 * roles, tagging, commenting, attaching).
 *
 * - **Only on a development database** (demo-guard.ts): NODE_ENV and the
 *   database's marker, both checked before anything is written.
 * - **Once, all or nothing:** the demo tenant and everything in it are one
 *   transaction (TenantsService.create(), as a tenant is always made: its
 *   roles with it), under an advisory lock; a database that has the demo
 *   tenant or demo users already is left as it is (`seeded: false`).
 * - **Members with passwords**, which no administrator's request can make
 *   (adding people is invite-only): the system-only path the first start
 *   uses for its administrator (`AccessAdminService.seedUser()`), verified
 *   accounts, generated passwords returned once (a fixed one would be in
 *   every breach list). The demo administrator administers the demo
 *   tenant only: the way any tenant gets its first administrator
 *   (`TenantsService.addAdministrator()`), never an operator.
 * - The notes belong to the demo users (their `mine` and `inMyTeams`
 *   conditions then show something), created on their behalf by the seed.
 */
@Injectable()
export class DemoSeeder {
  constructor(
    private readonly system: SystemContext,
    private readonly access: AccessService,
    private readonly accessAdmin: AccessAdminService,
    private readonly tenants: TenantsService,
    private readonly teams: TeamsService,
    private readonly users: UsersRepository,
    private readonly notes: NotesService,
    private readonly tags: TagsService,
    private readonly comments: CommentsService,
    private readonly attachments: AttachmentsService,
    private readonly disk: StorageDisk,
    private readonly audit: AuditService,
    private readonly singleTenant: SingleTenant,
  ) {}

  async seed(): Promise<DemoSeedResult> {
    // Read at the call, as set (demo-guard.ts): not ConfigService, whose
    // schema turns an unset NODE_ENV into development.
    const refused = nodeEnvRefusal(process.env.NODE_ENV);
    if (refused) {
      throw new DemoSeedRefused(refused);
    }
    // Files the transaction's rollback can't take back.
    const stored: string[] = [];
    try {
      // No tenant yet: the checks read global tables (tenants, users); the
      // tenant's own transaction is TenantsService.create()'s.
      return await this.system.run(
        DEMO_SEED_JOB,
        async () => {
          const created = await (
            this.singleTenant.enabled
              ? this.fillTheTenant(stored)
              : this.tenants
                  .create(
                    DEMO_TENANT,
                    null,
                    // Everything in the new tenant, in create()'s transaction.
                    (_tx, tenant) =>
                      this.system.run(
                        DEMO_SEED_JOB,
                        (system, tx) => this.fill(system, tx, tenant, stored),
                        { tenantId: tenant.id },
                      ),
                    (tx) => this.assertMaySeed(tx),
                  )
                  .then(({ result }) => result!)
          ).catch((error: unknown) => {
            if (error instanceof SeededAlready) {
              return { since: error.since };
            }
            throw error;
          });
          return 'since' in created
            ? { seeded: false as const, since: created.since }
            : created;
        },
        { transaction: false, tenantId: null },
      );
    } catch (error) {
      await this.disk.delete(stored).catch(() => undefined);
      throw error;
    }
  }

  /**
   * TENANCY=single (docs/tenancy.md, "Single-tenant deployments"): no
   * tenant of its own, which the deployment refuses, but the one there is,
   * in one transaction under the same lock and checks. That tenant is the
   * operators', so the demo administrator acts as an operator: a
   * development database only (demo-guard.ts), as every seed.
   */
  private async fillTheTenant(stored: string[]): Promise<DemoSeedResult> {
    const tenant = await this.singleTenant.tenant();
    return this.system.run(
      DEMO_SEED_JOB,
      async (system, tx) => {
        await this.assertMaySeed(tx);
        return this.fill(system, tx, tenant, stored);
      },
      { tenantId: tenant.id },
    );
  }

  /**
   * First in the transaction: one seed at a time, on a marked database,
   * where the demo isn't already (its tenant, or its users: accounts are
   * global).
   */
  private async assertMaySeed(tx: Transaction) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('demo:seed', 0))`,
    );
    const unmarked = markerRefusal(await isDevDatabase(tx));
    if (unmarked) {
      throw new DemoSeedRefused(unmarked);
    }
    const [tenant] = await tx
      .select({ createdAt: tenants.createdAt })
      .from(tenants)
      .where(eq(tenants.slug, DEMO_TENANT.slug));
    const [{ first }] = await tx
      .select({ first: min(users.createdAt) })
      .from(users)
      .where(like(users.email, `%@${DEMO_EMAIL_DOMAIN}`));
    const since = tenant?.createdAt ?? first;
    if (since) {
      throw new SeededAlready(since);
    }
  }

  private async fill(
    system: SystemPrincipal,
    tx: Transaction,
    tenant: { id: string; name: string },
    stored: string[],
  ): Promise<DemoSeedResult> {
    const tenantId = tenant.id;
    const teams = await this.createTeams(system);
    const people = await this.createUsers(system, tx, teams);
    const tags = await this.createTags(system, tx);
    for (const note of DEMO_NOTES) {
      await this.createNote(system, tenantId, note, people, tags, stored);
    }
    await this.audit.record(
      system,
      {
        action: 'demo.seeded',
        targetType: 'tenant',
        targetId: tenantId,
        details: {
          users: people.credentials.map((user) => user.email),
          notes: DEMO_NOTES.length,
        },
      },
      tx,
    );
    return {
      seeded: true,
      tenant: tenant.name,
      operators: this.singleTenant.enabled,
      users: people.credentials,
      notes: DEMO_NOTES.length,
    };
  }

  /** As `@Can(action, subject)` checks a request: the job must declare it. */
  private async assertCan(
    system: SystemPrincipal,
    action: string,
    subject: string,
  ) {
    if (!(await this.access.can(system, action, subject))) {
      throw new Error(
        `${system.name} may not ${subject}.${action}: declare it in DEMO_SEED_JOB (demo.jobs.ts).`,
      );
    }
  }

  private async createTeams(system: SystemPrincipal) {
    await this.assertCan(system, 'manageTeams', 'Access');
    const ids = new Map<string, string>();
    // Parents come first in DEMO_TEAMS.
    for (const team of DEMO_TEAMS) {
      const created = await this.teams.create(system, {
        name: team.name,
        parentId: team.parent ? ids.get(team.parent) : null,
      });
      ids.set(team.key, created.id);
    }
    return ids;
  }

  private async createUsers(
    system: SystemPrincipal,
    tx: Transaction,
    teams: Map<string, string>,
  ) {
    await this.assertCan(system, 'manageUsers', 'Access');
    // The tenant's roles, made with it in this transaction.
    const tenantRoles = await tx
      .select({ id: roles.id, key: roles.key, name: roles.name })
      .from(roles);
    const role = (key: string) => {
      const found = tenantRoles.find((candidate) => candidate.key === key);
      if (!found) {
        throw new Error(
          `The demo seed gives the role "${key}", which isn't seeded: change DEMO_USERS (demo-data.ts) with the roles.`,
        );
      }
      return found;
    };
    const ids = new Map<string, { id: string; email: string }>();
    const credentials: DemoCredentials[] = [];
    for (const user of DEMO_USERS) {
      const password = randomBytes(18).toString('base64url');
      const administrator = user.roles.includes(ADMINISTRATOR_ROLE);
      const created = await this.accessAdmin.seedUser(system, tx, {
        email: demoEmail(user.name),
        name: user.name,
        password,
        roleIds: user.roles
          .filter((key) => key !== ADMINISTRATOR_ROLE)
          .map((key) => role(key).id),
        teamIds: user.teams.map((key) => teams.get(key)!),
      });
      if (administrator) {
        // The tenant's first administrator, as every tenant gets one.
        await this.tenants.addAdministrator(tx, created.id);
      }
      ids.set(user.key, { id: created.id, email: created.email });
      credentials.push({
        email: created.email,
        name: user.name,
        roles: user.roles.map((key) => role(key).name),
        password,
      });
    }
    return { ids, credentials };
  }

  private async createTags(system: SystemPrincipal, tx: Transaction) {
    await this.assertCan(system, 'manageTags', 'Access');
    const ids = new Map<string, string>();
    for (const tag of DEMO_TAGS) {
      // A tenant that has one by that name already (TENANCY=single fills
      // the existing tenant): the demo notes get it, unchanged.
      const [existing] = await tx
        .select({ id: tagsTable.id })
        .from(tagsTable)
        .where(
          and(
            eq(tagsTable.subject, 'Note'),
            sql`lower(${tagsTable.name}) = lower(${tag.name})`,
          ),
        );
      if (existing) {
        ids.set(tag.key, existing.id);
        continue;
      }
      const created = await this.tags.create(system, {
        subject: 'Note',
        name: tag.name,
        color: tag.color,
      });
      ids.set(tag.key, created.id);
    }
    return ids;
  }

  private async createNote(
    system: SystemPrincipal,
    tenantId: string,
    note: DemoNote,
    people: { ids: Map<string, { id: string; email: string }> },
    tags: Map<string, string>,
    stored: string[],
  ) {
    await this.assertCan(system, 'create', 'Note');
    const owner = await this.users.inTenant(
      people.ids.get(note.owner)!.id,
      tenantId,
    );
    const created = await this.notes.create(
      owner!,
      { title: note.title, body: note.body },
      { by: system },
    );
    const record = { subject: 'Note', recordId: created.id };
    await this.tags.setTags(
      system,
      record,
      note.tags.map((key) => tags.get(key)!),
    );
    for (const comment of note.comments ?? []) {
      // `@maya` in the data: a mention of her address.
      const body = comment.replace(/@([a-z]+)/g, (mention, key: string) =>
        people.ids.has(key) ? `@${people.ids.get(key)!.email}` : mention,
      );
      await this.comments.add(system, record, body);
    }
    if (note.file) {
      await this.attachments.assertCanUpload(system, record);
      const content = Buffer.from(note.file.text, 'utf8');
      const contentType = 'text/plain; charset=utf-8';
      // Under the tenant's prefix, as an upload's (docs/tenancy.md).
      const key = tenantFileKey(tenantId, `attachments/${randomUUID()}.txt`);
      stored.push(key);
      await this.disk.put(key, content, { contentType });
      await this.attachments.attachStored(system, record, {
        key,
        name: note.file.name,
        size: content.length,
        contentType,
      });
    }
  }
}

/** The demo is there already: the transaction rolls back, nothing changes. */
class SeededAlready extends Error {
  constructor(readonly since: Date) {
    super('The demo data is already here.');
  }
}
