import { randomUUID } from 'node:crypto';
import { bootApp, type TestApp } from './support.js';

/** Dependent dropdowns (docs/choices.md): the built-in unit → member set. */
describe('dependent choices (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  async function unit(...members: { id: string }[]) {
    const created = await node
      .admin()
      .post('/v1/access/organizational-units')
      .send({ type: 'team', name: `unit-${randomUUID().slice(0, 6)}` })
      .expect(201);
    for (const member of members) {
      await node
        .admin()
        .post(`/v1/access/organizational-units/${created.body.id}/members`)
        .send({ userId: member.id })
        .expect(201);
    }
    return created.body.id as string;
  }

  it('describes the set, parents first, and answers a child for its parent only', async () => {
    const ann = await node.user(['editor']);
    const bob = await node.user(['editor']);
    const sales = await unit(ann);
    const ops = await unit(bob);

    const set = await ann.agent.get('/v1/choices/unit-member').expect(200);
    expect(set.body.fields.map((f: { name: string }) => f.name)).toEqual([
      'unit',
      'member',
    ]);
    expect(set.body.fields[1]).toMatchObject({ dependsOn: ['unit'] });

    const members = await ann.agent
      .get(`/v1/choices/unit-member/member/options?parent.unit=${sales}`)
      .expect(200);
    expect(members.body.parents).toEqual({ unit: sales });
    expect(members.body.items.map((i: { value: string }) => i.value)).toEqual([
      ann.id,
    ]);

    // Another unit's members are not hers to list: an empty answer, as for a unit that does not exist.
    expect(
      (
        await ann.agent
          .get(`/v1/choices/unit-member/member/options?parent.unit=${ops}`)
          .expect(200)
      ).body.items,
    ).toEqual([]);
    // Whoever manages users sees them.
    expect(
      (
        await node
          .admin()
          .get(`/v1/choices/unit-member/member/options?parent.unit=${ops}`)
          .expect(200)
      ).body.items,
    ).toHaveLength(1);

    // Bounded, typed parameters: missing, malformed or foreign ones are 400s.
    await ann.agent.get('/v1/choices/unit-member/member/options').expect(400);
    await ann.agent
      .get('/v1/choices/unit-member/member/options?parent.unit=nope')
      .expect(400);
    await ann.agent
      .get(
        `/v1/choices/unit-member/member/options?parent.unit=${sales}&limit=1000`,
      )
      .expect(400);
    await ann.agent
      .get('/v1/choices/unit-member/unit/options?parent.x=1')
      .expect(400);
    // Only registered sets and fields can be asked for.
    await ann.agent.get('/v1/choices/nothing').expect(404);
    await ann.agent.get('/v1/choices/unit-member/nothing/options').expect(404);
  });

  it('checks a value again on write: it must fit the parent sent with it', async () => {
    const ann = await node.user(['editor']);
    const bob = await node.user(['editor']);
    const sales = await unit(ann);
    const ops = await unit(bob);
    const check = (values: Record<string, string | null>) =>
      ann.agent.post('/v1/choices/unit-member/validate').send({ values });

    await check({ unit: sales, member: ann.id }).expect(204);
    // The parent changed under the child: the child no longer fits.
    const moved = await check({ unit: ops, member: bob.id }).expect(400);
    expect(moved.body.errors.map((e: { path: string }) => e.path)).toEqual([
      'member',
    ]);
    await check({ unit: sales, member: bob.id }).expect(400);
    await check({ member: ann.id }).expect(400);
    await check({ unit: randomUUID(), member: ann.id }).expect(400);
    await check({ unit: sales, member: 'a label' }).expect(400);
  });

  it('is for users: a client has no unit directory', async () => {
    const client = await node.client();
    await node
      .http()
      .get('/v1/choices/unit-member/unit/options')
      .set('Authorization', client.auth)
      .expect(403);
  });
});
