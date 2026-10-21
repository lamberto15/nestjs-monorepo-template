import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type request from 'supertest';
import { memberships, userRoles, users } from '../src/iam/iam.tables.js';
import { SSO_TXT_RESOLVER } from '../src/iam/sso/sso.queue.js';
import { fakeDns, verifyDomain } from './sso-support.js';
import { testItems } from './fixtures/test-items/test-items.tables.js';
import { bootApp, type TestApp } from './support.js';

const DOMAIN = 'acme.test';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

/**
 * SCIM 2.0 provisioning (docs/auth.md, "SCIM provisioning"): the IdP's
 * SCIM token is an API client key with Access.provisionScim; users and
 * groups (teams) of its tenant only.
 */
describe('SCIM provisioning (e2e)', () => {
  let node: TestApp;
  const dns = fakeDns();
  let scim: string;

  /** An API client of the agent's tenant whose role holds Access.provisionScim: its Authorization header. */
  const scimToken = async (
    agent: request.Agent,
    client: () => Promise<{ id: string; auth: string }>,
  ) => {
    const role = await agent
      .post('/v1/access/roles')
      .send({
        name: `scim-${randomUUID().slice(0, 8)}`,
        permissions: [
          { subject: 'Access', action: 'provisionScim', conditions: [] },
        ],
      })
      .expect(201);
    const created = await client();
    await agent
      .patch(`/v1/access/clients/${created.id}`)
      .send({ roleIds: [role.body.id] })
      .expect(200);
    return created.auth;
  };

  beforeAll(async () => {
    node = await bootApp(undefined, (builder) =>
      builder.overrideProvider(SSO_TXT_RESOLVER).useValue(dns.resolver),
    );
    await verifyDomain(node, dns, node.admin(), node.tenantId, DOMAIN);
    scim = await scimToken(node.admin(), () => node.client());
  });
  afterAll(() => node.close());

  const as = (auth: string) => ({
    get: (path: string) =>
      node.http().get(`/v1/scim${path}`).set('Authorization', auth),
    post: (path: string, body: object) =>
      node
        .http()
        .post(`/v1/scim${path}`)
        .set('Authorization', auth)
        .set('Content-Type', 'application/scim+json')
        .send(JSON.stringify(body)),
    put: (path: string, body: object) =>
      node
        .http()
        .put(`/v1/scim${path}`)
        .set('Authorization', auth)
        .set('Content-Type', 'application/scim+json')
        .send(JSON.stringify(body)),
    patch: (path: string, body: object) =>
      node
        .http()
        .patch(`/v1/scim${path}`)
        .set('Authorization', auth)
        .set('Content-Type', 'application/scim+json')
        .send(JSON.stringify(body)),
    delete: (path: string) =>
      node.http().delete(`/v1/scim${path}`).set('Authorization', auth),
  });

  const newUser = (overrides: Record<string, unknown> = {}) => {
    const email = `${randomUUID().slice(0, 8)}@${DOMAIN}`;
    return {
      schemas: [USER],
      userName: email,
      externalId: randomUUID(),
      name: { givenName: 'Ada', familyName: 'Lovelace' },
      emails: [{ value: email, primary: true, type: 'work' }],
      active: true,
      ...overrides,
    };
  };

  it('needs a key whose client holds Access.provisionScim, and answers SCIM errors', async () => {
    const unauthenticated = await node.http().get('/v1/scim/Users').expect(401);
    expect(unauthenticated.headers['content-type']).toContain(
      'application/scim+json',
    );
    expect(JSON.parse(unauthenticated.text).schemas).toEqual([ERROR]);
    const plain = await node.client();
    await as(plain.auth).get('/Users').expect(403);
    // A user's session is no SCIM token, whatever they may do.
    await node.admin().get('/v1/scim/Users').expect(401);
    const config = await as(scim).get('/ServiceProviderConfig').expect(200);
    expect(config.headers['content-type']).toContain('application/scim+json');
    expect(JSON.parse(config.text).patch.supported).toBe(true);
  });

  it('creates a user of a verified domain, who signs in nowhere but through SSO', async () => {
    const input = newUser();
    const created = await as(scim).post('/Users', input).expect(201);
    const user = JSON.parse(created.text);
    expect(created.headers.location).toBe(user.meta.location);
    expect(user).toMatchObject({
      userName: input.userName,
      externalId: input.externalId,
      active: true,
      name: input.name,
    });
    // A member of the tenant, as the access API shows them.
    const member = await node
      .admin()
      .get(`/v1/access/users/${user.id}`)
      .expect(200);
    expect(member.body.email).toBe(input.userName);
    expect(member.body.active).toBe(true);
    expect(
      (
        await node.auditEntries({
          action: 'scim.user-provisioned',
          targetId: user.id,
        })
      ).length,
    ).toBe(1);
    // Looked up as IdPs do before they create.
    const found = await as(scim)
      .get(
        `/Users?filter=${encodeURIComponent(`userName eq "${input.userName.toUpperCase()}"`)}`,
      )
      .expect(200);
    expect(JSON.parse(found.text)).toMatchObject({
      totalResults: 1,
      Resources: [{ id: user.id }],
    });
    // Again: a conflict, by address or by externalId.
    const again = await as(scim).post('/Users', input).expect(409);
    expect(JSON.parse(again.text)).toMatchObject({
      scimType: 'uniqueness',
      status: '409',
    });
  });

  it('refuses an address of an unverified domain, and an unsupported filter', async () => {
    const refused = await as(scim)
      .post('/Users', newUser({ userName: 'x@elsewhere.test', emails: [] }))
      .expect(400);
    expect(JSON.parse(refused.text).scimType).toBe('invalidValue');
    const filter = await as(scim)
      .get(`/Users?filter=${encodeURIComponent('userName co "a"')}`)
      .expect(400);
    expect(JSON.parse(filter.text).scimType).toBe('invalidFilter');
  });

  it('updates a user (PUT, PATCH) without changing the account’s name or address', async () => {
    const input = newUser();
    const user = JSON.parse(
      (await as(scim).post('/Users', input).expect(201)).text,
    );
    const replaced = await as(scim)
      .put(`/Users/${user.id}`, {
        ...input,
        displayName: 'Ada L.',
        title: 'Engineer',
      })
      .expect(200);
    expect(JSON.parse(replaced.text)).toMatchObject({
      displayName: 'Ada L.',
      title: 'Engineer',
    });
    const patched = await as(scim)
      .patch(`/Users/${user.id}`, {
        schemas: [PATCH],
        Operations: [
          { op: 'replace', path: 'name.givenName', value: 'Augusta' },
        ],
      })
      .expect(200);
    expect(JSON.parse(patched.text).name.givenName).toBe('Augusta');
    const member = await node
      .admin()
      .get(`/v1/access/users/${user.id}`)
      .expect(200);
    expect(member.body.name).toBe('Ada Lovelace');
  });

  it('deactivates a user (active false, then DELETE): the membership off, their sessions in the tenant ended', async () => {
    const input = newUser();
    const user = JSON.parse(
      (await as(scim).post('/Users', input).expect(201)).text,
    );
    // Azure sends its booleans as strings.
    const off = await as(scim)
      .patch(`/Users/${user.id}`, {
        schemas: [PATCH],
        Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
      })
      .expect(200);
    expect(JSON.parse(off.text).active).toBe(false);
    const member = await node
      .admin()
      .get(`/v1/access/users/${user.id}`)
      .expect(200);
    expect(member.body.active).toBe(false);
    // Back on, then deleted: gone from SCIM, the membership off.
    await as(scim)
      .patch(`/Users/${user.id}`, {
        schemas: [PATCH],
        Operations: [{ op: 'replace', value: { active: true } }],
      })
      .expect(200);
    await as(scim).delete(`/Users/${user.id}`).expect(204);
    await as(scim).get(`/Users/${user.id}`).expect(404);
    expect(
      (await node.admin().get(`/v1/access/users/${user.id}`).expect(200)).body
        .active,
    ).toBe(false);
  });

  it('ends the sessions of a deprovisioned member who signed in', async () => {
    // A member invited by an administrator, then taken over by the IdP.
    const email = `${randomUUID().slice(0, 8)}@${DOMAIN}`;
    const token = await node.invite(node.admin(), {
      email,
      name: email,
      roleIds: [],
    });
    const password = await node.acceptAsNew(token);
    const agent = await node.signIn(email, password);
    await agent.get('/v1/auth/me').expect(200);
    const user = JSON.parse(
      (
        await as(scim)
          .post(
            '/Users',
            newUser({
              userName: email,
              emails: [{ value: email, primary: true }],
            }),
          )
          .expect(201)
      ).text,
    );
    await as(scim)
      .put(`/Users/${user.id}`, {
        schemas: [USER],
        userName: email,
        active: false,
      })
      .expect(200);
    // Their only membership: the account is deactivated with it.
    await agent.get('/v1/auth/me').expect(401);
  });

  describe('deprovisioning the last membership (deactivated, never deleted)', () => {
    /**
     * A member of the seeded tenant only, an editor who signed in (a
     * session and a token family) and wrote a record, then linked by the
     * IdP: what its deprovisioning must end, and must keep.
     */
    const member = async () => {
      const email = `${randomUUID().slice(0, 8)}@${DOMAIN}`;
      const token = await node.invite(node.admin(), {
        email,
        name: 'Grace Hopper',
        roleIds: await node.roleIds('editor'),
      });
      const password = await node.acceptAsNew(token);
      const agent = await node.signIn(email, password);
      const me = await agent.get('/v1/auth/me').expect(200);
      const issued = await node
        .http()
        .post('/v1/auth/token')
        .send({ email, password })
        .expect(200);
      const item = await node
        .writeItem(agent, { title: 'Theirs', body: '' })
        .expect(201);
      const user = JSON.parse(
        (
          await as(scim)
            .post(
              '/Users',
              newUser({
                userName: email,
                emails: [{ value: email, primary: true }],
              }),
            )
            .expect(201)
        ).text,
      );
      expect(user.id).toBe(me.body.user.id);
      return {
        id: user.id as string,
        email,
        password,
        agent,
        bearer: `Bearer ${issued.body.accessToken}`,
        refreshToken: issued.body.refreshToken as string,
        itemId: item.body.id as string,
      };
    };

    const signInStatus = (email: string, password: string) =>
      node
        .http()
        .post('/v1/auth/sign-in')
        .send({ email, password })
        .then((res) => res.status);

    const account = async (id: string) =>
      (await node.db.select().from(users).where(eq(users.id, id)))[0];

    it('DELETE ends every session and token, refuses sign-in, keeps the data; POST brings the same account back', async () => {
      const person = await member();
      const before = await account(person.id);
      expect(before?.deprovisionedAt).toBeNull();

      // RFC 7644 §3.6: 204, then 404 for the deleted resource.
      await as(scim).delete(`/Users/${person.id}`).expect(204);
      await as(scim).get(`/Users/${person.id}`).expect(404);

      // The existing session, the access token and its refresh token: all ended.
      await person.agent.get('/v1/auth/me').expect(401);
      await node
        .http()
        .get('/v1/auth/me')
        .set('Authorization', person.bearer)
        .expect(401);
      await node
        .http()
        .post('/v1/auth/token/refresh')
        .send({ refreshToken: person.refreshToken })
        .expect(401);
      // No new sign-in, by password or for a token.
      expect(await signInStatus(person.email, person.password)).toBe(401);
      await node
        .http()
        .post('/v1/auth/token')
        .send({ email: person.email, password: person.password })
        .expect(401);

      // Deactivated, not deleted: the account, its membership and roles,
      // its record and its audit history are all still there.
      const after = await account(person.id);
      expect(after).toMatchObject({
        email: person.email,
        name: 'Grace Hopper',
        active: false,
      });
      expect(after?.deprovisionedAt).toBeInstanceOf(Date);
      expect(after?.passwordHash).toBe(before?.passwordHash);
      const [membership] = await node.db
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, person.id),
            eq(memberships.tenantId, node.tenantId),
          ),
        );
      expect(membership?.active).toBe(false);
      expect(
        await node.db
          .select()
          .from(userRoles)
          .where(eq(userRoles.userId, person.id)),
      ).toHaveLength(1);
      const [item] = await node.db
        .select()
        .from(testItems)
        .where(eq(testItems.id, person.itemId));
      expect(item?.ownerId).toBe(`user:${person.id}`);
      const deactivated = await node.auditEntries({
        action: 'scim.account-deactivated',
        targetId: person.id,
      });
      expect(deactivated).toHaveLength(1);
      expect(deactivated[0]?.details).toMatchObject({
        reason: 'no-active-membership',
      });
      expect(
        await node.auditEntries({
          action: 'scim.user-provisioned',
          targetId: person.id,
        }),
      ).toHaveLength(1);

      // Provisioned again: the same account, its password, roles and record.
      const again = JSON.parse(
        (
          await as(scim)
            .post(
              '/Users',
              newUser({
                userName: person.email,
                emails: [{ value: person.email, primary: true }],
              }),
            )
            .expect(201)
        ).text,
      );
      expect(again).toMatchObject({ id: person.id, active: true });
      expect(await account(person.id)).toMatchObject({
        active: true,
        deprovisionedAt: null,
      });
      const back = await node.signIn(person.email, person.password);
      const me = await back.get('/v1/auth/me').expect(200);
      expect(me.body.user).toMatchObject({
        id: person.id,
        tenantId: node.tenantId,
      });
      await back.get(`/v1/test-items/${person.itemId}`).expect(200);
      expect(
        await node.auditEntries({
          action: 'scim.account-reactivated',
          targetId: person.id,
        }),
      ).toHaveLength(1);
    });

    it('active false (PATCH) deactivates the account, active true (PUT) reactivates it', async () => {
      const person = await member();
      await as(scim)
        .patch(`/Users/${person.id}`, {
          schemas: [PATCH],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        })
        .expect(200);
      // Still the SCIM client's: answered, inactive (not a 404).
      const off = JSON.parse(
        (await as(scim).get(`/Users/${person.id}`).expect(200)).text,
      );
      expect(off.active).toBe(false);
      await person.agent.get('/v1/auth/me').expect(401);
      expect(await signInStatus(person.email, person.password)).toBe(401);
      expect((await account(person.id))?.active).toBe(false);

      await as(scim)
        .put(`/Users/${person.id}`, {
          schemas: [USER],
          userName: person.email,
          active: true,
        })
        .expect(200);
      expect(await signInStatus(person.email, person.password)).toBe(200);
      expect((await account(person.id))?.active).toBe(true);
    });

    it('keeps the account active while another tenant’s membership is', async () => {
      const person = await member();
      const other = await node.otherTenant();
      await node.db
        .insert(memberships)
        .values({ tenantId: other.id, userId: person.id });

      await as(scim).delete(`/Users/${person.id}`).expect(204);
      expect(await account(person.id)).toMatchObject({
        active: true,
        deprovisionedAt: null,
      });
      expect(
        await node.auditEntries({
          action: 'scim.account-deactivated',
          targetId: person.id,
        }),
      ).toHaveLength(0);
      // A new sign-in starts in the tenant they still belong to.
      const agent = await node.signIn(person.email, person.password);
      const me = await agent.get('/v1/auth/me').expect(200);
      expect(me.body.user.tenantId).toBe(other.id);
    });

    it('an administrator turning a membership back on reactivates the account', async () => {
      const person = await member();
      await as(scim).delete(`/Users/${person.id}`).expect(204);
      expect(await signInStatus(person.email, person.password)).toBe(401);
      await node
        .admin()
        .patch(`/v1/access/users/${person.id}`)
        .send({ active: true })
        .expect(204);
      expect(await signInStatus(person.email, person.password)).toBe(200);
      expect(
        await node.auditEntries({
          action: 'user.account-reactivated',
          targetId: person.id,
        }),
      ).toHaveLength(1);
    });
  });

  it('manages groups as teams, with provisioned users only', async () => {
    const alice = JSON.parse(
      (await as(scim).post('/Users', newUser()).expect(201)).text,
    );
    const bob = JSON.parse(
      (await as(scim).post('/Users', newUser()).expect(201)).text,
    );
    const outsider = await node.user(['viewer']);
    const created = await as(scim)
      .post('/Groups', {
        schemas: [GROUP],
        displayName: 'Engineering',
        externalId: randomUUID(),
        members: [{ value: alice.id }],
      })
      .expect(201);
    const group = JSON.parse(created.text);
    expect(group.members.map((m: { value: string }) => m.value)).toEqual([
      alice.id,
    ]);
    // A team of the tenant, as the access API shows it.
    const teams = await node.admin().get('/v1/access/teams').expect(200);
    expect(
      teams.body.items.find((team: { id: string }) => team.id === group.id),
    ).toMatchObject({ managedByScim: true });
    // Read-only in the app: the IdP manages its name, place and members.
    const renamed = await node
      .admin()
      .patch(`/v1/access/teams/${group.id}`)
      .send({ name: 'Renamed here' })
      .expect(409);
    expect(renamed.body.code).toBe('team_managed_by_scim');
    await node.admin().delete(`/v1/access/teams/${group.id}`).expect(409);
    const joined = await node
      .admin()
      .patch(`/v1/access/users/${outsider.id}`)
      .send({ teamIds: [group.id] })
      .expect(409);
    expect(joined.body.code).toBe('team_managed_by_scim');
    // PATCH: add one, remove one (by filter), rename.
    const patched = await as(scim)
      .patch(`/Groups/${group.id}`, {
        schemas: [PATCH],
        Operations: [
          { op: 'add', path: 'members', value: [{ value: bob.id }] },
          { op: 'remove', path: `members[value eq "${alice.id}"]` },
          { op: 'replace', path: 'displayName', value: 'Platform' },
        ],
      })
      .expect(200);
    expect(JSON.parse(patched.text)).toMatchObject({
      displayName: 'Platform',
      members: [{ value: bob.id }],
    });
    // A member the IdP did not provision: refused.
    const refused = await as(scim)
      .patch(`/Groups/${group.id}`, {
        schemas: [PATCH],
        Operations: [
          { op: 'add', path: 'members', value: [{ value: outsider.id }] },
        ],
      })
      .expect(400);
    expect(JSON.parse(refused.text).scimType).toBe('invalidValue');
    const found = await as(scim)
      .get(
        `/Groups?filter=${encodeURIComponent('displayName eq "platform"')}&excludedAttributes=members`,
      )
      .expect(200);
    expect(JSON.parse(found.text)).toMatchObject({
      totalResults: 1,
      Resources: [{ id: group.id }],
    });
    expect(JSON.parse(found.text).Resources[0].members).toBeUndefined();
    await as(scim).delete(`/Groups/${group.id}`).expect(204);
    await as(scim).get(`/Groups/${group.id}`).expect(404);
  });

  it('keeps tenants apart', async () => {
    const user = JSON.parse(
      (await as(scim).post('/Users', newUser()).expect(201)).text,
    );
    const group = JSON.parse(
      (
        await as(scim)
          .post('/Groups', { schemas: [GROUP], displayName: 'Ours' })
          .expect(201)
      ).text,
    );
    const other = await node.otherTenant();
    const theirs = await scimToken(other.admin, () => other.client());
    // Their token sees none of ours, and changes nothing of ours.
    await as(theirs).get(`/Users/${user.id}`).expect(404);
    await as(theirs).get(`/Groups/${group.id}`).expect(404);
    await as(theirs)
      .put(`/Users/${user.id}`, {
        schemas: [USER],
        userName: user.userName,
        active: false,
      })
      .expect(404);
    await as(theirs).delete(`/Users/${user.id}`).expect(404);
    await as(theirs).delete(`/Groups/${group.id}`).expect(404);
    const list = JSON.parse((await as(theirs).get('/Users').expect(200)).text);
    expect(list.totalResults).toBe(0);
    // Their tenant didn't verify acme.test: they can't provision its people.
    await as(theirs).post('/Users', newUser()).expect(400);
    expect(
      JSON.parse((await as(scim).get(`/Users/${user.id}`).expect(200)).text)
        .active,
    ).toBe(true);
  });
});
