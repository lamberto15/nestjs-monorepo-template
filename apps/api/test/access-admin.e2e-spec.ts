import { randomUUID } from 'node:crypto';
import { WebhookEndpoints } from '@nestjs/webhooks';
import { listSchema, pageSchema } from '../src/core/http/pagination.js';
import {
  catalogSchema,
  roleViewSchema,
  userViewSchema,
} from '../src/iam/access/access.schemas.js';
import { bootApp, connect, type TestApp, webhookReceiver } from './support.js';

/**
 * The access API's single-record routes, the users list's team filter, the
 * invitations' resend, the clients' quota on create and their deletion,
 * who may read (AccessPolicy.open), the list description of users and the
 * catalog's texts in the request's language (#115, #122).
 */
describe('access administration (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  /** A role made of these permissions (no conditions), by id. */
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

  async function team(name = `team-${randomUUID().slice(0, 8)}`) {
    const created = await node
      .admin()
      .post('/v1/access/teams')
      .send({ name })
      .expect(201);
    return created.body.id as string;
  }

  const pendingInvitations = async () =>
    (await node.admin().get('/v1/access/invitations').expect(200)).body
      .items as {
      id: string;
      email: string;
      roleIds: string[];
      roleExpiresAt: Record<string, string>;
      expiresAt: string;
    }[];

  describe('reading', () => {
    it('lets whoever manages teams, or impersonates, list what they work with', async () => {
      const teams = await node.user([await role(['Access', 'manageTeams'])]);
      await teams.agent.get('/v1/access/teams').expect(200);
      await teams.agent.get('/v1/access/users').expect(200);
      await teams.agent.get('/v1/access/roles').expect(200);
      await teams.agent.get('/v1/access/catalog').expect(200);

      // An SSO-only administrator reads the two lists the SSO page's pickers
      // use, nothing else, and changes nothing (#370).
      const sso = await node.user([await role(['Access', 'manageSso'])]);
      await sso.agent.get('/v1/access/users').expect(200);
      await sso.agent.get('/v1/access/roles').expect(200);
      for (const path of [
        '/v1/access/catalog',
        '/v1/access/teams',
        '/v1/access/clients',
        '/v1/access/principals',
      ]) {
        await sso.agent.get(path).expect(403);
      }
      await sso.agent
        .post('/v1/access/roles')
        .send({ name: 'Nope', permissions: [] })
        .expect(403);
      await sso.agent
        .post('/v1/access/teams')
        .send({ name: 'Nope' })
        .expect(403);

      const support = await node.user([await role(['Access', 'impersonate'])]);
      const users = await support.agent.get('/v1/access/users').expect(200);
      expect(users.body.items.length).toBeGreaterThan(0);
      await support.agent.get('/v1/access/principals').expect(200);
      // Not more than reading: managing stays with its own permission.
      await support.agent
        .post('/v1/access/teams')
        .send({ name: 'Nope' })
        .expect(403);

      const editor = await node.user(['editor']);
      await editor.agent.get('/v1/access/users').expect(403);
      await editor.agent.get('/v1/access/teams').expect(403);
    });

    it('answers one user and one role as the lists do', async () => {
      const member = await node.user(['editor']);
      const one = await node
        .admin()
        .get(`/v1/access/users/${member.id}`)
        .expect(200);
      const user = userViewSchema.strict().parse(one.body);
      const listed = pageSchema(userViewSchema)
        .parse(
          (await node.admin().get('/v1/access/users?limit=100').expect(200))
            .body,
        )
        .items.find((item) => item.id === member.id);
      expect(user).toEqual(listed);
      expect(user.roleIds).toEqual(await node.roleIds('editor'));
      await node.admin().get(`/v1/access/users/${randomUUID()}`).expect(404);

      const [editorRole] = await node.roleIds('editor');
      const fetched = await node
        .admin()
        .get(`/v1/access/roles/${editorRole}`)
        .expect(200);
      const parsed = roleViewSchema.strict().parse(fetched.body);
      const roles = listSchema(roleViewSchema).parse(
        (await node.admin().get('/v1/access/roles').expect(200)).body,
      );
      expect(parsed).toEqual(roles.items.find((r) => r.id === editorRole));
      expect(parsed.members).toBeGreaterThanOrEqual(1);
      await node.admin().get(`/v1/access/roles/${randomUUID()}`).expect(404);
      await node.admin().get('/v1/access/roles/not-a-uuid').expect(400);

      const editor = await node.user(['editor']);
      await editor.agent.get(`/v1/access/users/${member.id}`).expect(403);
      await editor.agent.get(`/v1/access/roles/${editorRole}`).expect(403);
    });

    it("filters the users by team: the team's own members", async () => {
      const parent = await team();
      const child = await node
        .admin()
        .post('/v1/access/teams')
        .send({ name: `child-${randomUUID().slice(0, 8)}`, parentId: parent })
        .expect(201);
      const [a, b, c] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await node
        .admin()
        .patch(`/v1/access/users/${a.id}`)
        .send({ teamIds: [parent] })
        .expect(204);
      await node
        .admin()
        .patch(`/v1/access/users/${b.id}`)
        .send({ teamIds: [child.body.id] })
        .expect(204);

      const ids = async (query: string) =>
        (
          (await node.admin().get(`/v1/access/users?${query}`).expect(200)).body
            .items as { id: string }[]
        )
          .map((user) => user.id)
          .sort((a, b) => a.localeCompare(b));
      expect(await ids(`teamId=${parent}`)).toEqual([a.id]);
      expect(await ids(`teamId=${child.body.id}`)).toEqual([b.id]);
      expect(await ids(`teamId.in=${parent},${child.body.id}`)).toEqual(
        [a.id, b.id].sort((a, b) => a.localeCompare(b)),
      );
      expect(await ids(`teamId=${randomUUID()}`)).toEqual([]);
      expect(await ids('limit=100')).toContain(c.id);
      await node.admin().get('/v1/access/users?teamId=nope').expect(400);
    });

    it('describes the users list at GET /v1/lists/User, to whoever may list them', async () => {
      const { body } = await node.admin().get('/v1/lists/User').expect(200);
      expect(body.subject).toBe('User');
      expect(body.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'teamId',
            type: 'uuid',
            operators: ['eq', 'in'],
            ref: 'team',
          }),
          expect.objectContaining({ name: 'email', sortable: true }),
        ]),
      );
      expect(body.select).toEqual(expect.arrayContaining(['email', 'roles']));
      expect(body.search).toBe(false);
      expect(body.recycleBin).toBe(false);
      expect(body.capabilities.comments).toBe(false);

      const teams = await node.user([await role(['Access', 'manageTeams'])]);
      await teams.agent.get('/v1/lists/User').expect(200);
      const editor = await node.user(['editor']);
      await editor.agent.get('/v1/lists/User').expect(403);
    });

    it("shows the catalog's texts in the request's language", async () => {
      const english = catalogSchema.parse(
        (await node.admin().get('/v1/access/catalog').expect(200)).body,
      );
      const access = english.subjects.find((s) => s.subject === 'Access')!;
      expect(access.label).toBe('Access control');
      expect(
        access.actions.find((a) => a.action === 'manageUsers')!.label,
      ).toBe(
        'Invite users, assign their roles and teams, deactivate their memberships',
      );

      const german = catalogSchema.parse(
        (await node.admin().get('/v1/access/catalog?lang=de').expect(200)).body,
      );
      expect(german.subjects.find((s) => s.subject === 'Access')!.label).toBe(
        'Zugriffssteuerung',
      );
      // The shared conditions too, and the system jobs.
      const condition = german.subjects
        .flatMap((s) => s.actions)
        .flatMap((a) => a.conditions)
        .find((c) => c.key === 'mine');
      expect(condition?.label).toBe('Von mir erstellt');
      expect(
        german.systemJobs.find((job) => job.key === 'audit-retention')!.label,
      ).toBe('Audit-Aufbewahrung');
      // The same subjects, actions and keys whatever the language.
      expect(german.subjects.map((s) => s.subject)).toEqual(
        english.subjects.map((s) => s.subject),
      );
    });
  });

  describe('invitations', () => {
    it('lists the role ends, and resends with a new link that keeps them', async () => {
      const email = `${randomUUID().slice(0, 8)}@example.com`;
      const [editorRole] = await node.roleIds('editor');
      const ends = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const first = await node.invite(node.admin(), {
        email,
        roleIds: [editorRole!],
        roleExpiresAt: { [editorRole!]: ends },
      } as Parameters<TestApp['invite']>[1]);
      const pending = (await pendingInvitations()).find(
        (item) => item.email === email,
      )!;
      expect(pending.roleIds).toEqual([editorRole]);
      expect(Date.parse(pending.roleExpiresAt[editorRole!]!)).toBe(
        Date.parse(ends),
      );

      const before = node.mailbox.filter({
        to: email,
        subject: /invited you to/,
      }).length;
      const resent = await node
        .admin()
        .post(`/v1/access/invitations/${pending.id}/resend`)
        .expect(202);
      expect(resent.body).toMatchObject({ id: pending.id, email });
      expect(Date.parse(resent.body.expiresAt)).toBeGreaterThanOrEqual(
        Date.parse(pending.expiresAt),
      );
      let second: string | undefined;
      for (let tries = 0; tries < 100 && !second; tries++) {
        const mails = node.mailbox.filter({
          to: email,
          subject: /invited you to/,
        });
        if (mails.length > before) {
          second = mails
            .at(-1)!
            .link('/accept-invitation')
            .searchParams.get('token')!;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(second).toBeDefined();
      expect(second).not.toBe(first);

      // The first link stopped working; the new one joins, with the ends.
      await node
        .http()
        .post('/v1/auth/invitations/accept')
        .send({ token: first, password: 'Kq8#fresh-pass-1' })
        .expect(400);
      await node.acceptAsNew(second!);
      const joined = (
        (await node.admin().get('/v1/access/users?limit=100').expect(200)).body
          .items as {
          email: string;
          roles: { roleId: string; expiresAt: string | null }[];
        }[]
      ).find((user) => user.email === email)!;
      expect(joined.roles).toHaveLength(1);
      expect(Date.parse(joined.roles[0]!.expiresAt!)).toBe(Date.parse(ends));

      const audit = await node.auditEntries({
        action: 'invitation.resent',
        targetId: pending.id,
      });
      expect(audit).toHaveLength(1);

      // Accepted: nothing to resend.
      await node
        .admin()
        .post(`/v1/access/invitations/${pending.id}/resend`)
        .expect(404);
      await node
        .admin()
        .post(`/v1/access/invitations/${randomUUID()}/resend`)
        .expect(404);
    });
  });

  describe('API clients', () => {
    it('creates a client with its quota and roles at once, and reads one', async () => {
      const [viewer] = await node.roleIds('viewer');
      const created = await node
        .admin()
        .post('/v1/access/clients')
        .send({
          name: `quota-${randomUUID().slice(0, 8)}`,
          dailyQuota: 500,
          roleIds: [viewer],
        })
        .expect(201);
      expect(created.body).toMatchObject({
        dailyQuota: 500,
        roles: [{ roleId: viewer, expiresAt: null }],
      });
      const one = await node
        .admin()
        .get(`/v1/access/clients/${created.body.id}`)
        .expect(200);
      const { key: _key, ...view } = created.body;
      expect(one.body).toEqual(view);
      expect(JSON.stringify(one.body)).not.toContain(created.body.key);
      const [entry] = await node.auditEntries({
        action: 'client.created',
        targetId: created.body.id,
      });
      expect(entry?.details).toMatchObject({ dailyQuota: 500 });

      // No quota: as before.
      const plain = await node.client();
      const read = await node
        .admin()
        .get(`/v1/access/clients/${plain.id}`)
        .expect(200);
      expect(read.body.dailyQuota).toBeNull();
      await node
        .admin()
        .post('/v1/access/clients')
        .send({ name: `bad-${randomUUID().slice(0, 8)}`, dailyQuota: 0 })
        .expect(400);
      await node.admin().get(`/v1/access/clients/${randomUUID()}`).expect(404);
    });

    it('deletes a client for good: its keys, endpoints and connections go with it', async () => {
      const receiver = await webhookReceiver();
      try {
        const client = await node.client();
        await node
          .http()
          .get('/v1/webhook-endpoints')
          .set('Authorization', client.auth)
          .expect(200);
        await node
          .http()
          .post('/v1/webhook-endpoints')
          .set('Authorization', client.auth)
          .send({ url: receiver.url, eventTypes: ['notification.created'] })
          .expect(201);
        const socket = await connect(node, client.key);
        const disconnected = new Promise<void>((resolve) =>
          socket.once('disconnect', () => resolve()),
        );

        await node
          .admin()
          .delete(`/v1/access/clients/${client.id}`)
          .expect(204);

        await node
          .http()
          .get('/v1/webhook-endpoints')
          .set('Authorization', client.auth)
          .expect(401);
        await node.admin().get(`/v1/access/clients/${client.id}`).expect(404);
        const listed = (
          await node.admin().get('/v1/access/clients').expect(200)
        ).body.items as { id: string }[];
        expect(listed.map((item) => item.id)).not.toContain(client.id);
        expect(
          await node.app
            .get(WebhookEndpoints)
            .list({ tenant: client.id, limit: 100 }),
        ).toEqual([]);
        await disconnected;
        socket.close();

        const [entry] = await node.auditEntries({
          action: 'client.deleted',
          targetId: client.id,
        });
        expect(entry?.details).toMatchObject({ name: expect.any(String) });

        await node
          .admin()
          .delete(`/v1/access/clients/${client.id}`)
          .expect(404);
      } finally {
        await receiver.close();
      }
    });

    it('is deleted only by whoever manages clients', async () => {
      const client = await node.client();
      const reader = await node.user([await role(['Access', 'manageTeams'])]);
      await reader.agent.get(`/v1/access/clients/${client.id}`).expect(200);
      await reader.agent.delete(`/v1/access/clients/${client.id}`).expect(403);
    });
  });
});
