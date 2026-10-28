import { randomUUID } from 'node:crypto';
import { bootApp, type TestApp } from './support.js';

describe('merge: duplicates found and merged into one record (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const item = async (body: Record<string, unknown>) =>
    (await node.writeItem(node.admin(), body).expect(201)).body as {
      id: string;
    };
  const merge = (id: string, body: Record<string, unknown>, path = 'merge') =>
    node.admin().post(`/v1/test-items/${id}/${path}`).send(body);

  it('finds duplicates by the title, before a create and for a record, among readable ones', async () => {
    const first = await item({ title: 'Acme Ltd' });
    const second = await item({ title: '  acme ltd ' });
    await item({ title: 'Other' });

    const before = await node
      .admin()
      .post('/v1/test-items/duplicates')
      .send({ values: { title: 'ACME LTD' } })
      .expect(200);
    expect(before.body.items.map((d: { id: string }) => d.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(before.body.items[0]).toMatchObject({
      matched: [['title']],
      record: { title: 'acme ltd' },
    });

    const of = await node
      .admin()
      .get(`/v1/test-items/${first.id}/duplicates`)
      .expect(200);
    expect(of.body.items.map((d: { id: string }) => d.id)).toEqual([second.id]);

    // Nothing to match by: no query, nothing found.
    const none = await node
      .admin()
      .post('/v1/test-items/duplicates')
      .send({ values: { body: 'x' } })
      .expect(200);
    expect(none.body.items).toEqual([]);

    // Another tenant's record is never a duplicate.
    const other = await node.otherTenant();
    const elsewhere = await other.admin
      .post('/v1/test-items/duplicates')
      .send({ values: { title: 'Acme Ltd' } })
      .expect(200);
    expect(elsewhere.body.items).toEqual([]);
  });

  it('previews, then merges in one step: chosen values, tags, comments, references, the duplicate in the bin; audited', async () => {
    const survivor = await item({ title: 'Acme', body: 'Old' });
    const duplicate = await item({
      title: 'ACME',
      body: 'New',
      code: `C-${randomUUID()}`,
    });
    const child = await item({ title: 'Child', parentId: duplicate.id });
    const tag = await node
      .admin()
      .post('/v1/tags')
      .send({ subject: 'TestItem', name: 'Vip' })
      .expect(201);
    await node
      .admin()
      .put(`/v1/test-items/${duplicate.id}/tags`)
      .send({ tagIds: [tag.body.id] })
      .expect(200);
    await node
      .admin()
      .post(`/v1/test-items/${duplicate.id}/comments`)
      .send({ body: 'Called them' })
      .expect(201);

    const body = {
      duplicateId: duplicate.id,
      fields: { body: 'duplicate', code: 'duplicate' },
    };
    const preview = await merge(survivor.id, body, 'merge/preview').expect(200);
    expect(preview.body.result).toMatchObject({ title: 'Acme', body: 'New' });
    expect(preview.body.fields).toContainEqual({
      name: 'body',
      survivor: 'Old',
      duplicate: 'New',
      differs: true,
      keep: 'duplicate',
    });
    expect(preview.body.moves).toMatchObject({
      tags: 1,
      comments: 1,
      references: [{ subject: 'TestItem', field: 'parentId', count: 1 }],
    });
    // A preview changes nothing.
    await node.admin().get(`/v1/test-items/${duplicate.id}`).expect(200);

    const merged = await merge(survivor.id, body).expect(200);
    // The duplicate's unique code is the survivor's now: it went to the bin first.
    expect(merged.body).toMatchObject({
      id: survivor.id,
      title: 'Acme',
      body: 'New',
      tags: [{ id: tag.body.id }],
    });
    await node.admin().get(`/v1/test-items/${duplicate.id}`).expect(404);
    const comments = await node
      .admin()
      .get(`/v1/test-items/${survivor.id}/comments`)
      .expect(200);
    expect(comments.body.items).toHaveLength(1);
    const moved = await node
      .admin()
      .get(`/v1/test-items/${child.id}`)
      .expect(200);
    expect(moved.body.parentId).toBe(survivor.id);

    const [entry] = await node.auditEntries({ action: 'testItem.merged' });
    expect(entry).toMatchObject({
      targetId: survivor.id,
      details: {
        duplicateId: duplicate.id,
        fields: ['body', 'code'],
        tags: [tag.body.id],
        references: [
          { subject: 'TestItem', field: 'parentId', ids: [child.id] },
        ],
      },
    });
    // Done once: the duplicate is gone, so a repeat finds nothing to merge.
    await merge(survivor.id, body).expect(404);
    // In the recycle bin, restorable once its unique code is free again:
    // the survivor holds it now, so a restore is refused, not duplicated.
    const restore = await node
      .admin()
      .post(`/v1/test-items/${duplicate.id}/restore`)
      .expect(409);
    expect(restore.body.code).toBe('testItem_taken');
  });

  it('never shows or takes a field hidden from the caller', async () => {
    const survivor = await item({ title: 'Acme', body: 'Mine' });
    const duplicate = await item({ title: 'Acme', body: 'Secret' });
    // Every record theirs to read, change and delete, but never its text.
    const role = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `Merger ${Date.now()}`,
        permissions: ['read', 'update', 'delete'].map((action) => ({
          subject: 'TestItem',
          action,
          conditions: [],
          fields: [],
        })),
      })
      .expect(201);
    const merger = await node.user([role.body.id]);
    const preview = await merger.agent
      .post(`/v1/test-items/${survivor.id}/merge/preview`)
      .send({ duplicateId: duplicate.id })
      .expect(200);
    const names = preview.body.fields.map((f: { name: string }) => f.name);
    expect(names).toContain('title');
    expect(names).not.toContain('body');
    expect(JSON.stringify(preview.body)).not.toContain('Secret');
    const refused = await merger.agent
      .post(`/v1/test-items/${survivor.id}/merge`)
      .send({ duplicateId: duplicate.id, fields: { body: 'duplicate' } })
      .expect(403);
    expect(refused.body.code).toBe('field_forbidden');
    await node.admin().get(`/v1/test-items/${duplicate.id}`).expect(200);
  });

  it('refuses what it should, changing nothing', async () => {
    const survivor = await item({ title: 'Acme' });
    const duplicate = await item({ title: 'Acme', body: 'Kept' });

    await merge(survivor.id, { duplicateId: survivor.id }).expect(422);
    const viewer = await node.user(['viewer']);
    await viewer.agent
      .post(`/v1/test-items/${survivor.id}/merge`)
      .send({ duplicateId: duplicate.id })
      .expect(403);

    // The survivor would refer to the duplicate, about to go.
    const child = await item({ title: 'Acme', parentId: duplicate.id });
    const self = await merge(child.id, { duplicateId: duplicate.id }).expect(
      422,
    );
    expect(self.body.code).toBe('merge_self_reference');

    // Under a legal hold, the duplicate stays.
    await node
      .admin()
      .post('/v1/legal-holds')
      .send({ subject: 'TestItem', recordId: duplicate.id, reason: 'Case' })
      .expect(201);
    const held = await merge(survivor.id, {
      duplicateId: duplicate.id,
      fields: { body: 'duplicate' },
    }).expect(409);
    expect(held.body.code).toBe('legal_hold');
    const after = await node
      .admin()
      .get(`/v1/test-items/${survivor.id}`)
      .expect(200);
    expect(after.body.body ?? null).toBeNull();
    const kept = await node
      .admin()
      .get(`/v1/test-items/${child.id}`)
      .expect(200);
    expect(kept.body.parentId).toBe(duplicate.id);
  });
});
