import { getDrizzleToken } from '@nestjs/drizzle';
import { OutboxRelay } from '@nestjs/outbox';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { inject } from 'vitest';
import type { Database } from '../../../src/core/database/drizzle.js';
import { DEMO_USERS } from '../../../src/demo/demo-data.js';
import {
  DEMO_NOTES,
  DEMO_TAGS,
} from '../../../src/features/notes/notes.demo-data.js';
import { DemoSeedModule } from '../../../src/demo/demo-seed.module.js';
import {
  type DemoCredentials,
  DemoSeeder,
} from '../../../src/demo/demo-seeder.js';
import { bootApp, type TestApp } from '../../support.js';

/**
 * What the notes feature adds to the demo seed (src/features/notes/notes.demo.ts):
 * tags, notes with their comments and files. The seed itself (guards, users,
 * roles, the tenant, once): test/demo-seed.e2e-spec.ts.
 */
describe('demo seed: notes (e2e)', () => {
  let node: TestApp;
  let db: Database;
  let seeder: DemoSeeder;

  beforeEach(async () => {
    node = await bootApp(undefined, undefined, { module: DemoSeedModule });
    db = node.app.get<Database>(getDrizzleToken());
    seeder = node.app.get(DemoSeeder);
  });
  afterEach(async () => {
    await node.close();
  });

  /**
   * Marks the test's database as the development services mark theirs
   * (dev/postgres/10-dev-database.sql): as the server's superuser, the only
   * kind of role that may.
   */
  async function markAsDevelopment() {
    const { rows } = (await db.execute(
      sql`select current_database() as name`,
    )) as unknown as { rows: { name: string }[] };
    const admin = new Client({ connectionString: inject('postgresUrl') });
    await admin.connect();
    try {
      await admin.query(
        `alter database "${rows[0]!.name}" set app.dev_database = 'on'`,
      );
    } finally {
      await admin.end();
    }
  }

  it('seeds the tags and notes, with comments and files, through the services', async () => {
    await markAsDevelopment();
    const result = await seeder.seed();
    if (!result.seeded) {
      throw new Error('expected the seed to run');
    }
    expect(result.users).toHaveLength(DEMO_USERS.length);
    expect(result.data).toEqual({
      notes: DEMO_NOTES.length,
      tags: DEMO_TAGS.length,
    });

    const credentials = (name: string) =>
      result.users.find((user) => user.name === name) as DemoCredentials;
    const signIn = (name: string) =>
      node.signIn(credentials(name).email, credentials(name).password);
    const titles = async (name: string) =>
      (
        (await (await signIn(name)).get('/v1/notes?limit=50').expect(200)).body
          .items as { title: string }[]
      )
        .map((note) => note.title)
        .sort((a, b) => a.localeCompare(b));

    // The roles' conditions apply to the notes, which are their owners':
    // an editor sees their own, a unit lead their units' (Sales and the
    // Sales North below it), a viewer every one.
    expect(await titles('Jonas Berg')).toEqual([
      'Call notes: Northwind renewal',
      'Pricing questions from Contoso',
    ]);
    expect(await titles('Maya Patel')).toEqual([
      'Call notes: Northwind renewal',
      'Pricing questions from Contoso',
      'Q3 targets for Sales',
      'Trade fair leads',
    ]);
    expect(await titles('Elena Novak')).toHaveLength(DEMO_NOTES.length);

    // The operators' administrator, in the operator tenant, sees none of it.
    const admin = await signIn('Noah Fischer');
    expect(
      (await node.admin().get('/v1/notes?limit=50').expect(200)).body.items,
    ).toEqual([]);

    // A note with its tags, its comment and its file, written by the seed.
    const [northwind] = (
      await admin
        .get(
          `/v1/notes?title.contains=${encodeURIComponent('Northwind')}&limit=5`,
        )
        .expect(200)
    ).body.items as {
      id: string;
      ownerId: string;
      tags: { name: string }[];
    }[];
    expect(
      northwind!.tags.map((tag) => tag.name).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['Customer', 'Urgent']);
    const jonas = (
      await admin
        .get(
          `/v1/access/users?email=${encodeURIComponent(credentials('Jonas Berg').email)}`,
        )
        .expect(200)
    ).body.items[0] as { id: string };
    expect(northwind!.ownerId).toBe(`user:${jonas.id}`);
    const comments = (
      await admin.get(`/v1/notes/${northwind!.id}/comments`).expect(200)
    ).body.items as { author: string; mentions: string[] }[];
    expect(comments).toEqual([
      expect.objectContaining({ author: 'system:demo-seed' }),
    ]);
    expect(comments[0]!.mentions).toHaveLength(1);
    const files = (
      await admin.get(`/v1/notes/${northwind!.id}/attachments`).expect(200)
    ).body.items as { name: string }[];
    expect(files.map((file) => file.name)).toEqual(['northwind-call.txt']);

    // The mention reached Maya, who may read the note (her unit's).
    await node.app.get(OutboxRelay).runOnce();
    const maya = await signIn('Maya Patel');
    const mentioned = (
      await maya.get('/v1/notifications?type=comment.mentioned').expect(200)
    ).body.items as unknown[];
    expect(mentioned).toHaveLength(1);

    // Every write is audited with the seed as its actor.
    const audited = (
      await admin
        .get('/v1/access/audit?actor=system:demo-seed&limit=100')
        .expect(200)
    ).body.items as { action: string }[];
    const actions = new Set(audited.map((entry) => entry.action));
    for (const action of [
      'tag.created',
      'note.created',
      'tags.changed',
      'comment.added',
      'attachment.added',
    ]) {
      expect(actions).toContain(action);
    }
  });
});
