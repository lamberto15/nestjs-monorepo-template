import { randomUUID } from 'node:crypto';
import { bootApp, type TestApp } from './support.js';

interface Person {
  key: string;
  name: string;
  avatarUrl: string | null;
}

/** GET /v1/people: the tenant's people, as every member sees them (docs/permissions.md, "The people directory"). */
describe('GET /v1/people (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  /** A member with this name and these roles, who accepted, signed in. */
  async function member(name: string, roles: string[] = []) {
    const email = `${randomUUID().slice(0, 8)}@example.com`;
    const token = await node.invite(node.admin(), {
      email,
      name,
      roleIds: await node.roleIds(...roles),
    });
    const password = await node.acceptAsNew(token);
    const agent = await node.signIn(email, password);
    const id = (await agent.get('/v1/auth/me').expect(200)).body.user
      .id as string;
    return { id, key: `user:${id}`, email, agent };
  }
  const tag = () => randomUUID().slice(0, 6);

  it('lets any member, without a role, find the active members by part of their name: key and name only', async () => {
    const t = tag();
    const maya = await member(`Maya ${t} Patel`, ['editor']);
    const mark = await member(`Mark ${t} Mayall`);
    const plain = await member(`Plain ${t}`);

    const found = await plain.agent
      .get(`/v1/people?q=${encodeURIComponent(`MAY`)}&limit=20`)
      .expect(200);
    const ours = (found.body.items as Person[]).filter((person) =>
      person.name.includes(t),
    );
    // By name; only a key and a name (no address, no role).
    expect(ours).toEqual([
      { key: mark.key, name: `Mark ${t} Mayall`, avatarUrl: null },
      { key: maya.key, name: `Maya ${t} Patel`, avatarUrl: null },
    ]);
    for (const person of found.body.items as object[]) {
      expect(Object.keys(person).sort((a, b) => a.localeCompare(b))).toEqual([
        'avatarUrl',
        'key',
        'name',
      ]);
    }

    // `%` and `_` are themselves, not wildcards.
    const wildcard = await plain.agent.get('/v1/people?q=%25').expect(200);
    expect(wildcard.body.items).toEqual([]);

    // A deactivated membership leaves the directory.
    await node
      .admin()
      .patch(`/v1/access/users/${mark.id}`)
      .send({ active: false })
      .expect(204);
    const after = await plain.agent
      .get(`/v1/people?q=${encodeURIComponent(t)}`)
      .expect(200);
    expect((after.body.items as Person[]).map((person) => person.key)).toEqual([
      maya.key,
      plain.key,
    ]);
  });

  it("never shows another tenant's people", async () => {
    const other = await node.otherTenant();
    const theirs = await other.user([]);
    const plain = await member(`Viewer ${tag()}`);
    const res = await plain.agent
      .get(`/v1/people?q=${encodeURIComponent(theirs.email)}`)
      .expect(200);
    expect(res.body.items).toEqual([]);
    // And theirs doesn't show ours.
    const back = await theirs.agent
      .get(`/v1/people?q=${encodeURIComponent('Viewer')}`)
      .expect(200);
    expect(
      (back.body.items as Person[]).some((person) => person.key === plain.key),
    ).toBe(false);
  });

  it('validates the query (400) and is for users only (an API key: 401)', async () => {
    const plain = await member(`Checker ${tag()}`);
    for (const query of [
      'limit=21',
      'limit=0',
      `q=${'x'.repeat(101)}`,
      'x=1',
    ]) {
      const res = await plain.agent.get(`/v1/people?${query}`).expect(400);
      expect(res.body.code).toBe('validation_failed');
    }
    const client = await node.client();
    await node
      .http()
      .get('/v1/people')
      .set('Authorization', client.auth)
      .expect(401);
    await node.http().get('/v1/people').expect(401);
  });

  describe('?key=: names behind keys', () => {
    it('names members, former members and API clients of the tenant, in the order asked; anything else is left out', async () => {
      const t = tag();
      const maya = await member(`Maya ${t}`);
      const gone = await member(`Gone ${t}`);
      const plain = await member(`Plain ${t}`);
      const client = await node.client(`Robot ${t}`);
      await node
        .admin()
        .patch(`/v1/access/users/${gone.id}`)
        .send({ active: false })
        .expect(204);
      const other = await node.otherTenant();
      const theirs = await other.user([]);
      const theirClient = await other.client();
      const keys = [
        gone.key,
        `client:${client.id}`,
        `user:${theirs.id}`,
        `client:${theirClient.id}`,
        `user:${randomUUID()}`,
        maya.key,
        gone.key,
      ];

      const res = await plain.agent
        .get(`/v1/people?key=${keys.join(',')}`)
        .expect(200);
      // A deactivated member keeps their name (they still own records);
      // another tenant's user or client, or no one, is simply absent.
      expect(res.body.items).toEqual([
        { key: gone.key, name: `Gone ${t}`, avatarUrl: null },
        { key: `client:${client.id}`, name: `Robot ${t}`, avatarUrl: null },
        { key: maya.key, name: `Maya ${t}`, avatarUrl: null },
      ]);

      // And the other tenant can't name ours.
      const back = await theirs.agent
        .get(`/v1/people?key=${maya.key},${gone.key}`)
        .expect(200);
      expect(back.body.items).toEqual([]);
    });

    it('validates the keys (400): their form, at most 20, not with q', async () => {
      const plain = await member(`Keys ${tag()}`);
      const many = Array.from({ length: 21 }, () => `user:${randomUUID()}`);
      for (const query of [
        'key=',
        `key=${randomUUID()}`,
        'key=user:not-a-uuid',
        `key=system:${randomUUID()}`,
        `key=${many.join(',')}`,
        `q=may&key=user:${randomUUID()}`,
      ]) {
        const res = await plain.agent.get(`/v1/people?${query}`).expect(400);
        expect(res.body.code).toBe('validation_failed');
      }
      await plain.agent
        .get(`/v1/people?key=${many.slice(0, 20).join(',')}`)
        .expect(200);
      await node.http().get(`/v1/people?key=user:${randomUUID()}`).expect(401);
    });
  });
});

/** GET /v1/teams: the tenant's teams, as every member sees them. */
describe('GET /v1/teams (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  const tag = () => randomUUID().slice(0, 6);
  interface TeamRef {
    id: string;
    name: string;
    parentId: string | null;
    depth: number;
  }

  /** A team of the default tenant, made by its administrator. */
  async function team(name: string, parentId?: string) {
    const res = await node
      .admin()
      .post('/v1/access/teams')
      .send({ name, parentId })
      .expect(201);
    return res.body.id as string;
  }

  it("lets a member without a role read the teams: id, name and tree only, never another tenant's", async () => {
    const t = tag();
    const top = await team(`Sales ${t}`);
    const north = await team(`North ${t}`, top);
    const east = await team(`East ${t}`, north);
    const other = await node.otherTenant();
    const theirs = (
      await other.admin
        .post('/v1/access/teams')
        .send({ name: `Sales ${t} elsewhere` })
        .expect(201)
    ).body.id as string;
    const plain = await node.user([]);
    await plain.agent.get('/v1/access/teams').expect(403);

    const res = await plain.agent
      .get(`/v1/teams?q=${encodeURIComponent(t)}`)
      .expect(200);
    expect(res.body).toEqual({
      items: [
        { id: east, name: `East ${t}`, parentId: north, depth: 2 },
        { id: north, name: `North ${t}`, parentId: top, depth: 1 },
        { id: top, name: `Sales ${t}`, parentId: null, depth: 0 },
      ],
      nextCursor: null,
    });

    // By id: ours, in a page; another tenant's or an unknown id is absent.
    const byId = await plain.agent
      .get(`/v1/teams?id=${top},${theirs},${randomUUID()}`)
      .expect(200);
    expect((byId.body.items as TeamRef[]).map((row) => row.id)).toEqual([top]);

    // Cursor pages: newest first, the next page after the cursor.
    const q = `q=${encodeURIComponent(t)}&limit=2`;
    const first = await plain.agent.get(`/v1/teams?${q}`).expect(200);
    expect((first.body.items as TeamRef[]).map((row) => row.id)).toEqual([
      east,
      north,
    ]);
    expect(first.body.nextCursor).toBe(north);
    const second = await plain.agent
      .get(`/v1/teams?${q}&cursor=${first.body.nextCursor}`)
      .expect(200);
    expect(second.body).toEqual({
      items: [{ id: top, name: `Sales ${t}`, parentId: null, depth: 0 }],
      nextCursor: null,
    });

    // Theirs reads only theirs.
    const back = await other.admin
      .get(`/v1/teams?q=${encodeURIComponent(t)}`)
      .expect(200);
    expect((back.body.items as TeamRef[]).map((row) => row.id)).toEqual([
      theirs,
    ]);
  });

  it('searches names with % and _ as themselves', async () => {
    const t = tag();
    const literal = await team(`Ops_100% ${t}`);
    await team(`Opsx100x ${t}`);
    const plain = await node.user([]);
    const res = await plain.agent
      .get(`/v1/teams?q=${encodeURIComponent(`ps_100% ${t}`)}`)
      .expect(200);
    expect((res.body.items as TeamRef[]).map((row) => row.id)).toEqual([
      literal,
    ]);
  });

  it('validates the query (400) and is for users only (an API key: 401)', async () => {
    const plain = await node.user([]);
    for (const query of [
      'q=',
      `q=${'x'.repeat(101)}`,
      'id=nope',
      `id=${Array.from({ length: 101 }, () => randomUUID()).join(',')}`,
      'limit=101',
      'cursor=nope',
      'x=1',
    ]) {
      const res = await plain.agent.get(`/v1/teams?${query}`).expect(400);
      expect(res.body.code).toBe('validation_failed');
    }
    const client = await node.client();
    await node
      .http()
      .get('/v1/teams')
      .set('Authorization', client.auth)
      .expect(401);
    await node.http().get('/v1/teams').expect(401);
  });

  it('is where the list metadata points a `team` and a `principal` ref', async () => {
    const document = JSON.stringify(
      (await node.http().get('/api-json').expect(200)).body,
    );
    expect(document).toContain('`team` (GET /v1/teams');
    expect(document).toContain('names keys with `key=`');
    expect(document).not.toContain('`team` (GET /v1/access/teams)');
  });
});
