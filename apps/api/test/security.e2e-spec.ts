import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { getDrizzleToken } from '@nestjs/drizzle';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../src/core/database/drizzle.js';
import { AccountService } from '../src/iam/account/account.service.js';
import { PasskeysService } from '../src/iam/account/passkeys.service.js';
import type { UserPrincipal } from '../src/iam/auth/principal.js';
import {
  magicLinks,
  passkeys,
  sessions,
  userIdentities,
  users,
} from '../src/iam/iam.tables.js';
import { SoftwareAuthenticator } from './software-authenticator.js';
import { accountDeletions } from '../src/platform/account/account.tables.js';
import { bootApp, type TestApp } from './support.js';

/**
 * The rules that keep one account from gaining rights through another:
 * regressions for the security review's findings.
 */
describe('security (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  /** A role made of these permissions (no conditions). */
  async function role(...permissions: [string, string][]) {
    const created = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `role-${randomUUID().slice(0, 8)}`,
        permissions: permissions.map(([subject, action]) => ({
          subject,
          action,
          conditions: [],
        })),
      })
      .expect(201);
    return created.body.id as string;
  }

  const adminId = async () =>
    (await node.admin().get('/v1/auth/me').expect(200)).body.user.id as string;

  it('lets nobody act on an account that holds more than they do', async () => {
    const support = await node.user([await role(['Access', 'manageUsers'])]);
    const admin = await adminId();
    // Not the administrator's roles, nor their activation…
    const refused = await support.agent
      .patch(`/v1/access/users/${admin}`)
      .send({ roleIds: [] })
      .expect(403);
    expect(refused.body.code).toBe('authority_required');
    await support.agent
      .patch(`/v1/access/users/${admin}`)
      .send({ active: false })
      .expect(403);
    // …but an account with fewer rights, yes.
    const viewerRole = await role(['TestItem', 'read']);
    const viewer = await node.user([viewerRole]);
    const supportHoldsItems = await node.user([
      await role(
        ['Access', 'manageUsers'],
        ['TestItem', 'read'],
        ['Ops', 'view'],
      ),
    ]);
    await supportHoldsItems.agent
      .patch(`/v1/access/users/${viewer.id}`)
      .send({ roleIds: [viewerRole] })
      .expect(204);
    // Own teams: never.
    const team = await node
      .admin()
      .post('/v1/access/teams')
      .send({ name: 'Sales' })
      .expect(201);
    await support.agent
      .patch(`/v1/access/users/${support.id}`)
      .send({ teamIds: [team.body.id] })
      .expect(403);
    // Teams are their own permission.
    await support.agent
      .post('/v1/access/teams')
      .send({ name: 'Mine' })
      .expect(403);
  });

  it('keeps a grant’s end when the roles are sent again', async () => {
    const [viewer] = await node.roleIds('viewer');
    const { id } = await node.user([]);
    const end = new Date(Date.now() + 3_600_000).toISOString();
    await node
      .admin()
      .patch(`/v1/access/users/${id}`)
      .send({ roleIds: [viewer], roleExpiresAt: { [viewer]: end } })
      .expect(204);
    await node
      .admin()
      .patch(`/v1/access/users/${id}`)
      .send({ roleIds: [viewer] })
      .expect(204);
    const users = await node
      .admin()
      .get('/v1/access/users?limit=100')
      .expect(200);
    const user = users.body.items.find((u: { id: string }) => u.id === id);
    expect(new Date(user.roles[0].expiresAt).toISOString()).toBe(end);
  });

  it('never lets impersonation reach more rights, nor manage access meanwhile', async () => {
    const supportRole = await role(
      ['Access', 'impersonate'],
      ['TestItem', 'read'],
    );
    const support = await node.user([supportRole]);
    const manager = await node.user([await role(['Access', 'manageUsers'])]);
    const weaker = await node.user([await role(['TestItem', 'read'])]);

    const refused = await support.agent
      .post(`/v1/access/users/${manager.id}/impersonate`)
      .expect(403);
    expect(refused.body.code).toBe('authority_required');

    // An administrator impersonating a manager can't use the manager's access rights.
    const admin = await node.signIn(
      process.env.ADMIN_EMAIL!,
      process.env.ADMIN_PASSWORD!,
    );
    await admin.post(`/v1/access/users/${manager.id}/impersonate`).expect(204);
    await admin
      .patch(`/v1/access/users/${weaker.id}`)
      .send({ name: 'Changed' })
      .expect(403);
    // Nor link an identity to the account (refused before the route looks for the provider).
    await admin.get('/v1/auth/oidc/google/login?link=true').expect(403);
    await admin.post('/v1/auth/impersonation/stop').expect(204);

    await support.agent
      .post(`/v1/access/users/${weaker.id}/impersonate`)
      .expect(204);
  });

  it('rotates only the keys of clients the actor has authority over', async () => {
    const clientManager = await node.user([
      await role(['Access', 'manageClients']),
    ]);
    const client = await node.client();
    await node
      .admin()
      .patch(`/v1/access/clients/${client.id}`)
      .send({ roleIds: await node.roleIds('viewer') })
      .expect(200);
    const refused = await clientManager.agent
      .post(`/v1/access/clients/${client.id}/rotate`)
      .expect(403);
    expect(refused.body.code).toBe('authority_required');
    const plain = await node.client();
    await clientManager.agent
      .post(`/v1/access/clients/${plain.id}/rotate`)
      .expect(200);
  });

  it('refuses keys that would already have expired', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await node
      .admin()
      .post('/v1/access/clients')
      .send({ name: `past-${Date.now()}`, keyExpiresAt: past })
      .expect(400);
    const client = await node.client();
    await node
      .admin()
      .post(`/v1/access/clients/${client.id}/rotate`)
      .send({ expiresAt: past })
      .expect(400);
  });

  it('checks field-level permissions on create', async () => {
    const titlesOnly = await role(['TestItem', 'read']);
    const creator = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `create-titles-${randomUUID().slice(0, 8)}`,
        permissions: [
          { subject: 'TestItem', action: 'create', conditions: [], fields: [] },
        ],
      })
      .expect(201);
    const user = await node.user([titlesOnly, creator.body.id]);
    const refused = await node
      .writeItem(user.agent, { title: 'T', body: 'secret text' })
      .expect(403);
    expect(refused.body).toMatchObject({
      code: 'field_forbidden',
      fields: ['body'],
    });
    await node.writeItem(user.agent, { title: 'T' }).expect(201);
  });

  it('refuses lists, exports, bulk runs and reports that filter, search, sort or select by a hidden field', async () => {
    // Reads every test item but none of its restrictable fields (body, custom); may delete.
    const blind = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `no-text-${randomUUID().slice(0, 8)}`,
        permissions: [
          { subject: 'TestItem', action: 'read', conditions: [], fields: [] },
          { subject: 'TestItem', action: 'delete', conditions: [] },
        ],
      })
      .expect(201);
    const user = await node.user([blind.body.id]);
    await node
      .writeItem(node.admin(), { title: 'Plain', body: 'zebracode inside' })
      .expect(201);
    const tree = (field: string) =>
      encodeURIComponent(
        JSON.stringify({
          and: [
            { field: 'title', op: 'contains', value: 'P' },
            { or: [{ field, op: 'contains', value: 'zebra' }] },
          ],
        }),
      );

    for (const query of [
      'body.contains=zebra', // a flat filter
      `filter=${tree('body')}`, // a condition nested in the tree
      'fields=title,body', // a field picked
      'q=zebracode', // the search document holds the text
      'sort=-rank', // ordered by that match
    ]) {
      const refused = await user.agent
        .get(`/v1/test-items?${query}`)
        .expect(403);
      expect(refused.body).toMatchObject({
        code: 'field_forbidden',
        fields: ['body'],
      });
    }
    // The custom values are hidden too: their filters and sorts with them.
    await node
      .admin()
      .post('/v1/custom-fields')
      .send({
        subject: 'TestItem',
        key: 'region',
        label: 'Region',
        type: 'select',
        options: [{ value: 'eu', label: 'Europe' }],
        filterable: true,
        sortable: true,
      })
      .expect(201);
    for (const query of ['custom.region=eu', 'sort=custom.region']) {
      const refused = await user.agent
        .get(`/v1/test-items?${query}`)
        .expect(403);
      expect(refused.body).toMatchObject({
        code: 'field_forbidden',
        fields: ['custom'],
      });
    }

    // The same on a field it may read: answered.
    for (const query of [
      'title.contains=Plain',
      `filter=${tree('title')}`,
      'fields=title',
      'sort=title',
    ]) {
      await user.agent.get(`/v1/test-items?${query}`).expect(200);
    }
    // Whoever may read the text filters, searches and sorts by it as before.
    for (const query of [
      'body.contains=zebra',
      `filter=${tree('body')}`,
      'fields=body',
      'q=zebracode&sort=-rank',
    ]) {
      const page = await node
        .admin()
        .get(`/v1/test-items?${query}`)
        .expect(200);
      expect(page.body.items).toHaveLength(1);
    }

    // The global search matches the title only: the text's word finds nothing.
    const search = await user.agent.get('/v1/search?q=zebracode').expect(200);
    expect(search.body.items).toEqual([]);
    expect(
      (await user.agent.get('/v1/search?q=plain').expect(200)).body.items,
    ).toHaveLength(1);
    expect(
      (await node.admin().get('/v1/search?q=zebracode').expect(200)).body.items,
    ).toHaveLength(1);

    // An export, a bulk run and a report select rows by the same filters.
    const exported = await user.agent
      .post('/v1/data/exports')
      .send({
        name: 'test-items',
        format: 'csv',
        filters: { 'body.contains': 'zebra' },
      })
      .expect(403);
    expect(exported.body.code).toBe('field_forbidden');
    const bulk = await user.agent
      .post('/v1/test-items/bulk')
      .set('Idempotency-Key', randomUUID())
      .send({ action: 'delete', filter: { 'body.contains': 'zebra' } })
      .expect(403);
    expect(bulk.body.code).toBe('field_forbidden');
    const report = await user.agent
      .post('/v1/reports')
      .send({
        name: 'Zebras',
        exporter: 'test-items',
        format: 'csv',
        timezone: 'UTC',
        schedule: { every: 'daily', hour: 8 },
        filters: { 'body.contains': 'zebra' },
      })
      .expect(403);
    expect(report.body.code).toBe('field_forbidden');
    await user.agent
      .post('/v1/data/exports')
      .send({
        name: 'test-items',
        format: 'csv',
        filters: { 'title.contains': 'Plain' },
      })
      .expect(202);
  });

  it('refuses filters, search and sorts on a field shown on some records only, and seals cursors', async () => {
    // Issue #76's role: own items with every field, the team's with none of
    // the restrictable ones (body, custom). Test items, not notes: the notes
    // example can be removed from a project, these tests stay.
    const conditional = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `own-text-${randomUUID().slice(0, 8)}`,
        permissions: [
          { subject: 'TestItem', action: 'create', conditions: [] },
          {
            subject: 'TestItem',
            action: 'read',
            conditions: [{ key: 'mine' }],
          },
          {
            subject: 'TestItem',
            action: 'read',
            conditions: [{ key: 'inMyTeams' }],
            fields: [],
          },
        ],
      })
      .expect(201);
    const team = await node
      .admin()
      .post('/v1/access/teams')
      .send({ name: `Team ${randomUUID().slice(0, 8)}` })
      .expect(201);
    const member = async () => {
      const created = await node.user([conditional.body.id]);
      await node
        .admin()
        .patch(`/v1/access/users/${created.id}`)
        .send({ teamIds: [team.body.id] })
        .expect(204);
      return created;
    };
    const [caller, teammate] = [await member(), await member()];
    await node
      .admin()
      .post('/v1/custom-fields')
      .send({
        subject: 'TestItem',
        key: 'grade',
        label: 'Grade',
        type: 'select',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        filterable: true,
        sortable: true,
      })
      .expect(201);
    const theirs = await node
      .writeItem(teammate.agent, {
        title: 'Theirs',
        body: 'layoffquokka planned',
        custom: { grade: 'b' },
      })
      .expect(201);
    await node
      .writeItem(caller.agent, {
        title: 'Mine',
        body: 'my own text',
        custom: { grade: 'a' },
      })
      .expect(201);
    // Both are listed; the teammate's without its text.
    const all = await caller.agent.get('/v1/test-items').expect(200);
    expect(all.body.items).toHaveLength(2);

    for (const [query, fields] of [
      ['body.contains=layoff', ['body']],
      ['q=layoffquokka', ['body']],
      ['q=layoffquokka&sort=-rank', ['body']],
      ['custom.grade=b', ['custom']],
      ['sort=custom.grade', ['custom']],
    ] as const) {
      const refused = await caller.agent
        .get(`/v1/test-items?${query}`)
        .expect(403);
      expect(refused.body, query).toMatchObject({
        code: 'field_forbidden',
        fields,
      });
    }
    // Selecting it is answered: redaction decides per record.
    const picked = await caller.agent
      .get('/v1/test-items?fields=title,body')
      .expect(200);
    const byTitle = Object.fromEntries(
      picked.body.items.map((item: { title: string }) => [item.title, item]),
    );
    expect(byTitle.Mine.body).toBe('my own text');
    expect(byTitle.Theirs).not.toHaveProperty('body');
    expect(byTitle.Theirs.id).toBe(theirs.body.id);

    // The list's description says the same.
    const described = await caller.agent.get('/v1/lists/TestItem').expect(200);
    expect(described.body.search).toBe(false);
    expect(
      described.body.fields.find(
        (field: { name: string }) => field.name === 'custom.grade',
      ),
    ).toMatchObject({ operators: [], sortable: false });
    expect(described.body.select).toEqual(
      expect.arrayContaining(['body', 'custom.grade']),
    );

    // The global search matches the title only: the hidden text's word finds nothing.
    expect(
      (await caller.agent.get('/v1/search?q=layoffquokka').expect(200)).body
        .items,
    ).toEqual([]);
    expect(
      (await node.admin().get('/v1/search?q=layoffquokka').expect(200)).body
        .items,
    ).toHaveLength(1);

    // Whoever reads the field on every record they read filters by it as before.
    const own = await node.user([
      (
        await node
          .admin()
          .post('/v1/access/roles')
          .send({
            name: `own-${randomUUID().slice(0, 8)}`,
            permissions: [
              {
                subject: 'TestItem',
                action: 'read',
                conditions: [{ key: 'mine' }],
              },
            ],
          })
          .expect(201)
      ).body.id,
    ]);
    await own.agent.get('/v1/test-items?q=layoffquokka').expect(200);
    await own.agent.get('/v1/test-items?sort=custom.grade').expect(200);

    // A sorted cursor holds the sort values sealed: no value, not even JSON.
    const sorted = await node
      .admin()
      .get('/v1/test-items?sort=custom.grade,title&limit=1')
      .expect(200);
    const cursor = sorted.body.nextCursor as string;
    expect(cursor).toEqual(expect.any(String));
    expect(() =>
      JSON.parse(Buffer.from(cursor, 'base64url').toString()),
    ).toThrow();
    for (const part of cursor.split('.')) {
      expect(Buffer.from(part, 'base64url').toString('latin1')).not.toMatch(
        /Mine|Theirs|"a"|"b"/,
      );
    }
    const next = await node
      .admin()
      .get(
        `/v1/test-items?sort=custom.grade,title&limit=1&cursor=${encodeURIComponent(cursor)}`,
      )
      .expect(200);
    expect(next.body.items[0].id).not.toBe(sorted.body.items[0].id);
    // Another sort, a changed cursor, a forged one: the invalid-cursor 400.
    const changed = `${cursor.slice(0, -2)}${cursor.endsWith('AA') ? 'AB' : 'AA'}`;
    for (const [sort, bad] of [
      ['title', cursor],
      ['custom.grade,title', changed],
      [
        'custom.grade,title',
        Buffer.from(
          JSON.stringify({
            s: 'custom.grade,title',
            v: ['a', 'Mine'],
            id: randomUUID(),
          }),
        ).toString('base64url'),
      ],
    ]) {
      const refused = await node
        .admin()
        .get(`/v1/test-items?sort=${sort}&cursor=${encodeURIComponent(bad)}`)
        .expect(400);
      expect(JSON.stringify(refused.body)).toContain(
        'cursor is not the nextCursor of this list and sort',
      );
    }
  });

  it('never unlinks the last way to sign in, even with two unlinks at once', async () => {
    const { id } = await node.user([]);
    const db = node.db;
    await db.update(users).set({ passwordHash: null }).where(eq(users.id, id));
    await db.insert(userIdentities).values([
      { provider: 'google', subject: `g-${id}`, userId: id },
      { provider: 'github', subject: `h-${id}`, userId: id },
    ]);
    const account = node.app.get(AccountService);
    const user = {
      kind: 'user',
      id,
      email: `${id}@example.com`,
      name: 'Linked only',
    } as UserPrincipal;
    const results = await Promise.allSettled([
      account.unlinkIdentity(user, 'google'),
      account.unlinkIdentity(user, 'github'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason.getStatus()).toBe(409);
    const left = await db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, id));
    expect(left).toHaveLength(1);
  });

  it('never removes the last way to sign in when a passkey and a provider go at once', async () => {
    const { id } = await node.user([]);
    const db = node.db;
    await db.update(users).set({ passwordHash: null }).where(eq(users.id, id));
    await db
      .insert(userIdentities)
      .values({ provider: 'google', subject: `g-${id}`, userId: id });
    const [passkey] = await db
      .insert(passkeys)
      .values({
        userId: id,
        name: 'Key',
        credentialId: `cred-${id}`,
        publicKey: 'AA',
        deviceType: 'singleDevice',
      })
      .returning();
    const user = {
      kind: 'user',
      id,
      email: `${id}@example.com`,
      name: 'Two ways in',
    } as UserPrincipal;
    const results = await Promise.allSettled([
      node.app.get(AccountService).unlinkIdentity(user, 'google'),
      node.app.get(PasskeysService).remove(user, passkey.id, '127.0.0.1'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason.getStatus()).toBe(409);
  });

  it('takes a passkey challenge once, even from two requests at once, and only for its account', async () => {
    const owner = await node.user([]);
    const device = new SoftwareAuthenticator({
      origin: process.env.WEB_URL!,
    });
    const options = (
      await owner.agent
        .post('/v1/auth/passkeys/registration/options')
        .expect(200)
    ).body;
    await owner.agent
      .post('/v1/auth/passkeys')
      .send({ name: 'Key', response: device.create(options).response })
      .expect(201);
    const signInOptions = async (body: object = {}) =>
      (
        await node
          .http()
          .post('/v1/auth/passkeys/sign-in/options')
          .send(body)
          .expect(200)
      ).body;
    const assertion = device.get(await signInOptions());
    const answers = await Promise.all(
      [0, 1].map(() =>
        node
          .http()
          .post('/v1/auth/passkeys/sign-in')
          .send({ response: assertion }),
      ),
    );
    expect(answers.map((res) => res.status).sort((a, b) => a - b)).toEqual([
      200, 401,
    ]);

    // The owner's credential, presented under another account's user handle.
    const other = await node.user([]);
    const forged = device.get(await signInOptions());
    forged.response.userHandle = Buffer.from(
      other.id.replace(/-/g, ''),
      'hex',
    ).toString('base64url');
    await node
      .http()
      .post('/v1/auth/passkeys/sign-in')
      .send({ response: forged })
      .expect(401);
  });

  it('answers a query parameter sent twice on the OIDC routes with a redirect or a 400, never a 500', async () => {
    // `?redirectTo=/a&redirectTo=//evil` reaches the handler as an array:
    // a string method on it threw (500), and the array could not be
    // checked as a path of the web app (CodeQL
    // js/type-confusion-through-parameter-tampering). Linking from a stale
    // session is the flow that reads `redirectTo`, to send the browser back.
    const me = await node.user(['editor']);
    const db = node.db;
    const current = (
      (await me.agent.get('/v1/auth/sessions').expect(200)).body.items as {
        id: string;
        current: boolean;
      }[]
    ).find((item) => item.current)!;
    await db
      .update(sessions)
      .set({
        metadata: sql`${sessions.metadata} || ${JSON.stringify({
          authenticatedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
        })}::jsonb`,
      })
      .where(eq(sessions.id, current.id));
    const twice = await me.agent
      .get(
        '/v1/auth/oidc/google/login?link=true&redirectTo=/settings&redirectTo=//evil.example',
      )
      .expect(302);
    // Not a string: as if absent, so the web app's root.
    expect(twice.headers.location).toBe(
      'https://web.example.com/?error=reauthentication_required',
    );
    // `link` twice is not `true`: not a link flow, so past the checks the
    // route's 404 (no provider is configured here), not a 500.
    await me.agent
      .get('/v1/auth/oidc/google/login?link=true&link=true')
      .expect(404);
    // The callback: a repeated `code` or `state` is refused before anything reads it.
    const refused = await node
      .http()
      .get('/v1/auth/oidc/google/callback?code=a&code=b&state=s')
      .expect(400);
    expect(refused.body.code).toBe('validation_failed');
    expect(refused.body.errors).toEqual([
      { path: 'code', message: expect.any(String) },
    ]);
    await node
      .http()
      .get('/v1/auth/oidc/google/callback?code=a&state=s&state=t')
      .expect(400);
  });

  describe('redirectTo: a path of the web app, never another site (#74)', () => {
    /** Every spelling of "another site" a browser, a URL parser or a once-decoding client follows. */
    const offSite = [
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      '/\t/evil.example',
      '/%09/evil.example',
      '/%5Cevil.example',
      '/.//evil.example',
      '/x\n',
      ' /x',
      'https://evil.example',
      'javascript:alert(1)',
      `/${'a'.repeat(2048)}`,
    ];

    it('refuses a magic-link request whose redirectTo could leave the web app (400), and stores nothing', async () => {
      const { email } = await node.user([]);
      // One address each: the route allows 5 requests per address.
      for (const [i, redirectTo] of offSite.entries()) {
        const refused = await node
          .http()
          .post('/v1/auth/magic-link')
          .set('X-Forwarded-For', `10.74.${i}.1`)
          .send({ email, redirectTo })
          .expect(400);
        expect(refused.body.code, JSON.stringify(redirectTo)).toBe(
          'validation_failed',
        );
        expect(refused.body.errors).toEqual([
          { path: 'redirectTo', message: expect.any(String) },
        ]);
      }
      expect(
        await node.db.$count(magicLinks, eq(magicLinks.email, email)),
      ).toBe(0);
      await node
        .http()
        .post('/v1/auth/magic-link')
        .set('X-Forwarded-For', '10.74.255.1')
        .send({ email, redirectTo: '/a/b?x=1#h' })
        .expect(202);
    });

    it('never answers a stored redirectTo that could leave the web app (a link from before the rule)', async () => {
      const { email } = await node.user([]);
      const asking = request.agent(node.app.getHttpServer());
      await asking
        .post('/v1/auth/magic-link')
        .send({ email, redirectTo: '/inbox' })
        .expect(202);
      const mail = await node.waitForMail({
        to: email,
        subject: 'Your sign-in link',
      });
      const token = mail.link('/magic-link').searchParams.get('token')!;
      // Stored before the rule (or by an older package): an off-site path.
      await node.db
        .update(magicLinks)
        .set({ redirectTo: '/\\evil.example' })
        .where(eq(magicLinks.email, email));
      const signedIn = await asking
        .post('/v1/auth/magic-link/verify')
        .send({ token })
        .expect(200);
      expect(signedIn.body).toEqual({ signedIn: true, mfaRequired: false });
    });

    it('sends a browser leaving the OIDC login to the web app, whatever redirectTo says', async () => {
      // Linking from a stale session reads `redirectTo` with no provider configured.
      const me = await node.user([]);
      const current = (
        (await me.agent.get('/v1/auth/sessions').expect(200)).body.items as {
          id: string;
          current: boolean;
        }[]
      ).find((item) => item.current)!;
      await node.db
        .update(sessions)
        .set({
          metadata: sql`${sessions.metadata} || ${JSON.stringify({
            authenticatedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
          })}::jsonb`,
        })
        .where(eq(sessions.id, current.id));
      for (const redirectTo of offSite) {
        const sent = await me.agent
          .get('/v1/auth/oidc/google/login')
          .query({ link: 'true', redirectTo })
          .expect(302);
        expect(sent.headers.location, JSON.stringify(redirectTo)).toBe(
          'https://web.example.com/?error=reauthentication_required',
        );
      }
    });
  });

  describe("the deletion mail's cancel link (no sign-in)", () => {
    /** Someone who asked for their account's deletion, and the token of the mail's link. */
    async function pendingDeletion() {
      const { id, email, password, agent } = await node.user([]);
      await agent.post('/v1/account/deletion').send({ password }).expect(200);
      const mail = await node.waitForMail({ to: email, subject: /deleted/ });
      const token = mail.link('/cancel-deletion').searchParams.get('token')!;
      return { id, email, password, agent, token };
    }
    const address = () =>
      `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
    const cancel = (token: string, from = address()) =>
      node
        .http()
        .post('/v1/account/deletion/cancel')
        .set('X-Forwarded-For', from)
        .send({ token });
    const stillPending = async (
      agent: Awaited<ReturnType<typeof pendingDeletion>>['agent'],
    ) => (await agent.get('/v1/account').expect(200)).body.deletion !== null;

    it('is no credential: never accepted as a bearer token, and an access token cancels nothing', async () => {
      const ada = await pendingDeletion();
      await node
        .http()
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${ada.token}`)
        .expect(401);
      const { accessToken } = (
        await node
          .http()
          .post('/v1/auth/token')
          .send({ email: ada.email, password: ada.password })
          .expect(200)
      ).body as { accessToken: string };
      await cancel(accessToken).expect(400);
      expect(await stillPending(ada.agent)).toBe(true);
    });

    it("can't be altered to cancel another person's deletion", async () => {
      const ada = await pendingDeletion();
      const bob = await pendingDeletion();
      const [header, payload, signature] = ada.token.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      const bobDeletion = await node.app
        .get<Database>(getDrizzleToken())
        .select({ id: accountDeletions.id })
        .from(accountDeletions)
        .where(eq(accountDeletions.userId, bob.id));
      for (const forged of [
        { ...claims, sub: bob.id },
        { ...claims, sub: bob.id, did: bobDeletion[0].id },
      ]) {
        const body = Buffer.from(JSON.stringify(forged)).toString('base64url');
        await cancel(`${header}.${body}.${signature}`).expect(400);
      }
      // Unsigned (alg none), with Bob's ids.
      const none = Buffer.from(
        JSON.stringify({ alg: 'none', typ: 'JWT' }),
      ).toString('base64url');
      const bobClaims = Buffer.from(
        JSON.stringify({ ...claims, sub: bob.id, did: bobDeletion[0].id }),
      ).toString('base64url');
      await cancel(`${none}.${bobClaims}.`).expect(400);
      expect(await stillPending(bob.agent)).toBe(true);
      expect(await stillPending(ada.agent)).toBe(true);
    });

    it('says nothing: one answer for a forged, a used and an outdated link, and no replay', async () => {
      const ada = await pendingDeletion();
      const bodies: Record<string, unknown>[] = [];
      const strip = ({ requestId: _r, ...rest }: Record<string, unknown>) =>
        rest;
      bodies.push(strip((await cancel('x'.repeat(40)).expect(400)).body));
      await cancel(ada.token).expect(204);
      bodies.push(strip((await cancel(ada.token).expect(400)).body));
      // Asked again: the first link stays dead, it names the earlier request.
      await ada.agent
        .post('/v1/account/deletion')
        .send({ password: ada.password })
        .expect(200);
      bodies.push(strip((await cancel(ada.token).expect(400)).body));
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      expect(await stillPending(ada.agent)).toBe(true);
      // Two uses at once: one cancels, the other is refused.
      await ada.agent.delete('/v1/account/deletion').expect(204);
      await ada.agent
        .post('/v1/account/deletion')
        .send({ password: ada.password })
        .expect(200);
      const mails = node.mailbox.filter({ to: ada.email, subject: /deleted/ });
      for (let tries = 0; mails.length < 3 && tries < 100; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        mails.splice(
          0,
          mails.length,
          ...node.mailbox.filter({ to: ada.email, subject: /deleted/ }),
        );
      }
      const latest = mails[2]
        .link('/cancel-deletion')
        .searchParams.get('token')!;
      const both = await Promise.all([cancel(latest), cancel(latest)]);
      expect(both.map((res) => res.status).sort((a, b) => a - b)).toEqual([
        204, 400,
      ]);
      const cancelled = await node.auditEntries({
        action: 'account.deletion-cancelled',
        targetId: ada.id,
      });
      // The first link, the signed-in cancel, and one of the two at once:
      // each the user's own, in no tenant.
      expect(cancelled).toHaveLength(3);
      expect(cancelled.every((entry) => entry.tenantId === null)).toBe(true);
    });

    it('is limited per address', async () => {
      const from = address();
      for (let i = 0; i < 10; i++) {
        await cancel(`guess-${i}`, from).expect(400);
      }
      await cancel('guess-10', from).expect(429);
    });
  });
});
