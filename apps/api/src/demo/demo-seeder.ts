import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { StorageDisk } from '@nestjs/storage';
import { like, min, sql } from 'drizzle-orm';
import type { Transaction } from '../core/database/drizzle.js';
import { NotesService } from '../features/notes/notes.service.js';
import { AccessAdminService } from '../iam/access/access-admin.service.js';
import { AccessService } from '../iam/access/access.service.js';
import { OrgUnitsService } from '../iam/access/org-units.service.js';
import { SystemContext } from '../iam/access/system-context.js';
import { AuditService } from '../iam/audit/audit.service.js';
import type { SystemPrincipal } from '../iam/auth/principal.js';
import { UsersRepository } from '../iam/auth/users.repository.js';
import { users } from '../iam/iam.tables.js';
import { AttachmentsService } from '../platform/attachments/attachments.service.js';
import { CommentsService } from '../platform/comments/comments.service.js';
import { TagsService } from '../platform/tags/tags.service.js';
import {
  DEMO_EMAIL_DOMAIN,
  DEMO_NOTES,
  DEMO_ORG_UNITS,
  DEMO_TAGS,
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
  | { seeded: true; users: DemoCredentials[]; notes: number }
  | { seeded: false; since: Date };

/** A demo user's address: `maya.patel@demo.example.com`. */
const demoEmail = (name: string) =>
  `${name.toLowerCase().replace(/\s+/g, '.')}@${DEMO_EMAIL_DOMAIN}`;

/**
 * The demo data (demo-data.ts), written through the services an
 * administrator's requests go through, as the system principal
 * `system:demo-seed` (DEMO_SEED_JOB): every write has its audit entry with
 * the seed as the actor, and the job's declared permissions are checked
 * where a controller would check them (`@Can()`), and by the services
 * themselves (granting roles, tagging, commenting, attaching).
 *
 * - **Only on a development database** (demo-guard.ts): NODE_ENV and the
 *   database's marker, both checked before anything is written.
 * - **Once:** all of it in one transaction, under an advisory lock; a
 *   database that has demo users already is left as it is (`seeded:
 *   false`), so a second run, or two at once, change nothing.
 * - **Passwords are generated** and returned once (a fixed one would be in
 *   every breach list, and the breach check refuses those).
 * - The notes belong to the demo users (their `mine` and `inMyUnits`
 *   conditions then show something), created on their behalf by the seed.
 */
@Injectable()
export class DemoSeeder {
  constructor(
    private readonly system: SystemContext,
    private readonly access: AccessService,
    private readonly accessAdmin: AccessAdminService,
    private readonly orgUnits: OrgUnitsService,
    private readonly users: UsersRepository,
    private readonly notes: NotesService,
    private readonly tags: TagsService,
    private readonly comments: CommentsService,
    private readonly attachments: AttachmentsService,
    private readonly disk: StorageDisk,
    private readonly audit: AuditService,
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
    // Outside the transaction: its queries run at once (Promise.all), and
    // a transaction is one connection, which runs one query at a time.
    const roles = await this.accessAdmin.listRoles();
    try {
      // Tenancy (roadmap 1a): create the demo tenant here, before the run,
      // and pass `{ tenantId }` to it: every step below then writes in it.
      return await this.system.run(DEMO_SEED_JOB, async (system, tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('demo:seed', 0))`,
        );
        const unmarked = markerRefusal(await isDevDatabase(tx));
        if (unmarked) {
          throw new DemoSeedRefused(unmarked);
        }
        const since = await this.seededAt(tx);
        if (since) {
          return { seeded: false, since };
        }
        const units = await this.createOrgUnits(system);
        const people = await this.createUsers(system, units, roles);
        const tags = await this.createTags(system);
        for (const note of DEMO_NOTES) {
          await this.createNote(system, note, people, tags, stored);
        }
        await this.audit.record(
          system,
          {
            action: 'demo.seeded',
            details: {
              users: people.credentials.map((user) => user.email),
              notes: DEMO_NOTES.length,
            },
          },
          tx,
        );
        return {
          seeded: true,
          users: people.credentials,
          notes: DEMO_NOTES.length,
        };
      });
    } catch (error) {
      await this.disk.delete(stored).catch(() => undefined);
      throw error;
    }
  }

  /** When the demo users were made, if they were: the first one's creation. */
  private async seededAt(tx: Transaction) {
    const [{ first }] = await tx
      .select({ first: min(users.createdAt) })
      .from(users)
      .where(like(users.email, `%@${DEMO_EMAIL_DOMAIN}`));
    return first;
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

  private async createOrgUnits(system: SystemPrincipal) {
    await this.assertCan(system, 'manageOrgUnits', 'Access');
    const ids = new Map<string, string>();
    // Parents come first in DEMO_ORG_UNITS.
    for (const unit of DEMO_ORG_UNITS) {
      const created = await this.orgUnits.create(system, {
        name: unit.name,
        parentId: unit.parent ? ids.get(unit.parent) : null,
      });
      ids.set(unit.key, created.id);
    }
    return ids;
  }

  private async createUsers(
    system: SystemPrincipal,
    units: Map<string, string>,
    roles: { id: string; key: string | null; name: string }[],
  ) {
    await this.assertCan(system, 'manageUsers', 'Access');
    const role = (key: string) => {
      const found = roles.find((candidate) => candidate.key === key);
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
      const email = demoEmail(user.name);
      const created = await this.accessAdmin.createUser(system, {
        email,
        name: user.name,
        password,
        roleIds: user.roles.map((key) => role(key).id),
        orgUnitIds: user.units.map((key) => units.get(key)!),
      });
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

  private async createTags(system: SystemPrincipal) {
    await this.assertCan(system, 'manageTags', 'Access');
    const ids = new Map<string, string>();
    for (const tag of DEMO_TAGS) {
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
    note: DemoNote,
    people: { ids: Map<string, { id: string; email: string }> },
    tags: Map<string, string>,
    stored: string[],
  ) {
    await this.assertCan(system, 'create', 'Note');
    const owner = await this.users.findActive(people.ids.get(note.owner)!.id);
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
      const key = `attachments/${randomUUID()}.txt`;
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
