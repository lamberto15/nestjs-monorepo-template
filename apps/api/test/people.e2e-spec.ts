import { randomUUID } from 'node:crypto';
import { bootApp, type TestApp } from './support.js';

interface Person {
  key: string;
  name: string;
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
      { key: mark.key, name: `Mark ${t} Mayall` },
      { key: maya.key, name: `Maya ${t} Patel` },
    ]);
    for (const person of found.body.items as object[]) {
      expect(Object.keys(person).sort()).toEqual(['key', 'name']);
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
});
