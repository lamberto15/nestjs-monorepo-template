import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { bootApp, type TestApp } from './support.js';

describe('tags (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const paths = (body: { errors?: { path: string }[] }) =>
    (body.errors ?? []).map((error) => error.path);
  const names = (tags: { name: string }[]) => tags.map((tag) => tag.name);

  /** A TestItem tag, made by the administrator. */
  async function tag(name: string, color?: string) {
    const created = await node
      .admin()
      .post('/v1/tags')
      .send({ subject: 'TestItem', name, ...(color && { color }) })
      .expect(201);
    return created.body as { id: string; name: string; color: string | null };
  }

  it('lets only tag managers create, change and delete tags; anyone signed in reads them', async () => {
    const editor = await node.user(['editor']);
    const viewer = await node.user(['viewer']);

    for (const someone of [editor, viewer]) {
      await someone.agent
        .post('/v1/tags')
        .send({ subject: 'TestItem', name: 'Nope' })
        .expect(403);
    }

    const created = await node
      .admin()
      .post('/v1/tags')
      .send({
        subject: 'TestItem',
        name: 'Urgent',
        color: '#FF0000',
        description: 'Do it now',
      })
      .expect(201);
    expect(created.body).toMatchObject({
      subject: 'TestItem',
      name: 'Urgent',
      color: '#ff0000',
      description: 'Do it now',
    });
    const id = created.body.id as string;

    await editor.agent.patch(`/v1/tags/${id}`).send({ name: 'x' }).expect(403);
    await viewer.agent.delete(`/v1/tags/${id}`).expect(403);

    // The same name in another case: taken.
    const duplicate = await node
      .admin()
      .post('/v1/tags')
      .send({ subject: 'TestItem', name: 'URGENT' })
      .expect(409);
    expect(duplicate.body.code).toBe('conflict');

    const bad = await node
      .admin()
      .post('/v1/tags')
      .send({ subject: 'TestItem', name: 'Red', color: 'red' })
      .expect(400);
    expect(paths(bad.body)).toEqual(['color']);
    const unknown = await node
      .admin()
      .post('/v1/tags')
      .send({ subject: 'Invoice', name: 'Paid' })
      .expect(400);
    expect(unknown.body.code).toBe('validation_failed');
    expect(paths(unknown.body)).toEqual(['subject']);

    const later = await tag('Later');
    const renamed = await node
      .admin()
      .patch(`/v1/tags/${id}`)
      .send({ name: 'Critical', color: null })
      .expect(200);
    expect(renamed.body).toMatchObject({ name: 'Critical', color: null });
    await node
      .admin()
      .patch(`/v1/tags/${later.id}`)
      .send({ name: 'critical' })
      .expect(409);
    await node
      .admin()
      .patch(`/v1/tags/${randomUUID()}`)
      .send({ name: 'Gone' })
      .expect(404);

    // Reading: everyone; filters by subject and name.
    const all = await viewer.agent.get('/v1/tags?subject=TestItem').expect(200);
    expect(names(all.body.items)).toEqual(['Later', 'Critical']);
    const sorted = await editor.agent.get('/v1/tags?sort=name').expect(200);
    expect(names(sorted.body.items)).toEqual(['Critical', 'Later']);
    expect(
      names(
        (await editor.agent.get('/v1/tags?name.contains=RIT').expect(200)).body
          .items,
      ),
    ).toEqual(['Critical']);
    expect(
      names(
        (await editor.agent.get('/v1/tags?name=later').expect(200)).body.items,
      ),
    ).toEqual(['Later']);
    expect(
      (await editor.agent.get('/v1/tags?subject=Invoice').expect(200)).body
        .items,
    ).toEqual([]);

    await node.admin().delete(`/v1/tags/${later.id}`).expect(204);
    await node.admin().delete(`/v1/tags/${later.id}`).expect(404);

    const audit = async (action: string) =>
      (
        await node
          .admin()
          .get(`/v1/access/audit?action=${action}&targetId=${id}`)
          .expect(200)
      ).body.items;
    expect(await audit('tag.created')).toHaveLength(1);
    expect((await audit('tag.updated'))[0].details).toEqual({
      changes: {
        name: { from: 'Urgent', to: 'Critical' },
        color: { from: '#ff0000', to: null },
      },
    });
    expect(
      (
        await node
          .admin()
          .get(`/v1/access/audit?action=tag.deleted&targetId=${later.id}`)
          .expect(200)
      ).body.items,
    ).toHaveLength(1);
  });

  it('tags test items: those who may change one set its tags; test items show and filter by them', async () => {
    const editor = await node.user(['editor']);
    const viewer = await node.user(['viewer']);
    const [urgent, later] = [
      await tag('Urgent', '#ff0000'),
      await tag('Later'),
    ];
    const first = (
      await node.writeItem(editor.agent, { title: 'First', body: '' })
    ).body.id as string;
    const second = (
      await node.writeItem(editor.agent, { title: 'Second', body: '' })
    ).body.id as string;
    await node
      .writeItem(editor.agent, { title: 'Untagged', body: '' })
      .expect(201);

    const set = (agent: request.Agent, id: string, tagIds: string[]) =>
      agent.put(`/v1/test-items/${id}/tags`).send({ tagIds });

    const answer = await set(editor.agent, first, [later.id, urgent.id]).expect(
      200,
    );
    expect(answer.body.items).toEqual([
      { id: later.id, name: 'Later', color: null },
      { id: urgent.id, name: 'Urgent', color: '#ff0000' },
    ]);
    // Tags are part of the test item's representation: its ETag moves with them.
    const stale = (
      await editor.agent.get(`/v1/test-items/${second}`).expect(200)
    ).headers.etag!;
    await set(editor.agent, second, [later.id]).expect(200);
    const fresh = (
      await editor.agent.get(`/v1/test-items/${second}`).expect(200)
    ).headers.etag!;
    expect(fresh).not.toBe(stale);
    await editor.agent
      .patch(`/v1/test-items/${second}`)
      .set('If-Match', stale)
      .send({ title: 'Second!' })
      .expect(412);

    // The viewer reads test items but may not change them.
    await set(viewer.agent, first, []).expect(403);
    await set(editor.agent, randomUUID(), []).expect(404);

    // A tag that doesn't exist, or tags another subject: named by its path.
    const missing = await set(editor.agent, first, [
      urgent.id,
      randomUUID(),
    ]).expect(400);
    expect(missing.body.code).toBe('validation_failed');
    expect(paths(missing.body)).toEqual(['tagIds.1']);
    await set(editor.agent, first, ['not-a-uuid']).expect(400);

    // The test item and the list carry them.
    const one = await editor.agent.get(`/v1/test-items/${first}`).expect(200);
    expect(names(one.body.tags)).toEqual(['Later', 'Urgent']);
    const list = await viewer.agent.get('/v1/test-items').expect(200);
    const byTitle = Object.fromEntries(
      list.body.items.map(
        (item: { title: string; tags: { name: string }[] }) => [
          item.title,
          names(item.tags),
        ],
      ),
    );
    expect(byTitle).toEqual({
      First: ['Later', 'Urgent'],
      Second: ['Later'],
      Untagged: [],
    });
    const picked = await viewer.agent
      .get('/v1/test-items?fields=tags')
      .expect(200);
    expect(Object.keys(picked.body.items[0]).sort()).toEqual(['id', 'tags']);

    // Filters: one tag, any of several.
    const titles = async (query: string) =>
      (
        await viewer.agent.get(`/v1/test-items${query}`).expect(200)
      ).body.items.map((item: { title: string }) => item.title);
    expect(await titles(`?tag=${urgent.id}`)).toEqual(['First']);
    expect(await titles(`?tag=${later.id}`)).toEqual(['Second', 'First']);
    expect(await titles(`?tag.in=${urgent.id},${later.id}`)).toEqual([
      'Second',
      'First',
    ]);
    expect(
      await titles(
        `?filter=${encodeURIComponent(JSON.stringify({ field: 'tag', op: 'eq', value: urgent.id }))}`,
      ),
    ).toEqual(['First']);
    await viewer.agent.get('/v1/test-items?tag=nope').expect(400);

    // Replacing the set; then deleting a tag removes it from every test item.
    await set(editor.agent, second, [urgent.id]).expect(200);
    expect(
      names(
        (await editor.agent.get(`/v1/test-items/${second}`).expect(200)).body
          .tags,
      ),
    ).toEqual(['Urgent']);
    await node.admin().delete(`/v1/tags/${urgent.id}`).expect(204);
    expect(
      (await editor.agent.get(`/v1/test-items/${second}`).expect(200)).body
        .tags,
    ).toEqual([]);
    expect(
      names(
        (await editor.agent.get(`/v1/test-items/${first}`).expect(200)).body
          .tags,
      ),
    ).toEqual(['Later']);
    expect(await titles(`?tag=${urgent.id}`)).toEqual([]);

    // One audit entry per change of a test item's set, from → to.
    const changes = (
      await node
        .admin()
        .get(`/v1/access/audit?action=tags.changed&targetId=${second}`)
        .expect(200)
    ).body.items;
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      targetType: 'testItem',
      details: {
        subject: 'TestItem',
        from: [later.id],
        to: [urgent.id],
        added: [urgent.id],
        removed: [later.id],
      },
    });
  });

  it('exports the tags of each test item', async () => {
    const editor = await node.user(['editor']);
    const urgent = await tag('Urgent');
    const later = await tag('Later');
    const id = (
      await node.writeItem(editor.agent, { title: 'Tagged', body: '' })
    ).body.id as string;
    await node
      .writeItem(editor.agent, { title: 'Untagged', body: '' })
      .expect(201);
    await editor.agent
      .put(`/v1/test-items/${id}/tags`)
      .send({ tagIds: [urgent.id, later.id] })
      .expect(200);

    const started = await editor.agent
      .post('/v1/data/exports')
      .send({ name: 'test-items', format: 'csv' })
      .expect(202);
    let done: { status: string; result: { url: string } } | undefined;
    for (let tries = 0; tries < 100 && done?.status !== 'completed'; tries++) {
      done = (
        await editor.agent
          .get(`/v1/data/transfers/${started.body.id}`)
          .expect(200)
      ).body;
      expect(done!.status).not.toBe('failed');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(done?.status).toBe('completed');
    const { pathname, search } = new URL(done!.result.url);
    const file = await node
      .http()
      .get(pathname + search)
      .expect(200);
    const [header, ...rows] = file.text.trim().split(/\r?\n/);
    expect(header).toContain('tags');
    expect(
      rows.find((row) => row.includes('Tagged') && !row.includes('Untagged')),
    ).toContain('"Later, Urgent"');
    // An import ignores the column: the template has none.
    const template = await editor.agent
      .get('/v1/data/imports/test-items/template')
      .expect(200);
    expect(template.text).not.toContain('tags');
  });
});
