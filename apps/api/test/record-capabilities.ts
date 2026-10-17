import { randomUUID } from 'node:crypto';
import {
  fieldSamples,
  searchableFields,
} from '../src/platform/fields/fields.js';
import type { RecordDeclaration } from '../src/platform/records/record.js';
import type { TestApp } from './support.js';

/**
 * The tests of each capability a record declares (platform/records), and of
 * its recycle bin (`softDelete`) and teams (`team`), for a feature's e2e
 * spec: `describeCapabilities(() => node, INVOICE)`. A capability added to
 * the declaration later, or a flag flipped, is tested with no change to the
 * spec; records are made with the declaration's sample bodies.
 */
export function describeCapabilities(
  node: () => TestApp,
  record: RecordDeclaration,
) {
  const path = `/v1/${record.path}`;
  const samples = fieldSamples(record.fields);
  const has = (capability: RecordDeclaration['capabilities'][number]) =>
    record.capabilities.includes(capability);
  const make = async () =>
    (
      await node()
        .admin()
        .post(path)
        .set('Idempotency-Key', randomUUID())
        .send(samples.body())
        .expect(201)
    ).body.id as string;

  if (record.softDelete) {
    it('goes to the recycle bin, and comes back until the purge', async () => {
      const admin = node().admin();
      const id = await make();
      await admin.delete(`${path}/${id}`).expect(204);
      await admin.get(`${path}/${id}`).expect(404);
      const bin = (await admin.get(`${path}?deleted=true`).expect(200)).body
        .items as { id: string; deletedAt: string | null }[];
      expect(bin.find((item) => item.id === id)?.deletedAt).toEqual(
        expect.any(String),
      );
      await admin.post(`${path}/${id}/restore`).expect(200);
      expect(
        (await admin.get(`${path}/${id}`).expect(200)).body.deletedAt,
      ).toBe(null);
    });
  } else {
    it('is deleted for good: no recycle bin', async () => {
      const admin = node().admin();
      const id = await make();
      await admin.delete(`${path}/${id}`).expect(204);
      await admin.post(`${path}/${id}/restore`).expect(404);
      const kept = await make();
      expect(
        (await admin.get(`${path}/${kept}`).expect(200)).body,
      ).not.toHaveProperty('deletedAt');
    });
  }

  if (record.team) {
    it("belongs to its creator's team: the team's leads see it", async () => {
      const admin = node().admin();
      const team = (
        await admin
          .post('/v1/access/teams')
          .send({ name: `Team ${randomUUID().slice(0, 8)}` })
          .expect(201)
      ).body.id as string;
      const writer = await node().user(['editor']);
      await admin
        .patch(`/v1/access/users/${writer.id}`)
        .send({ teamIds: [team] })
        .expect(204);
      const created = await writer.agent
        .post(path)
        .set('Idempotency-Key', randomUUID())
        .send(samples.body())
        .expect(201);
      expect(created.body.teamId).toBe(team);
      const id = created.body.id as string;
      const lead = await node().user(['team-lead']);
      await lead.agent.get(`${path}/${id}`).expect(403);
      await admin
        .patch(`/v1/access/users/${lead.id}`)
        .send({ teamIds: [team] })
        .expect(204);
      await lead.agent.get(`${path}/${id}`).expect(200);
    });
  } else {
    it('has no team', async () => {
      const id = await make();
      expect(
        (await node().admin().get(`${path}/${id}`).expect(200)).body,
      ).not.toHaveProperty('teamId');
    });
  }

  if (has('tags')) {
    it('takes tags, and lists by them', async () => {
      const admin = node().admin();
      const id = await make();
      const tag = (
        await admin
          .post('/v1/tags')
          .send({ subject: record.subject, name: 'Urgent' })
          .expect(201)
      ).body.id as string;
      await admin
        .put(`${path}/${id}/tags`)
        .send({ tagIds: [tag] })
        .expect(200);
      expect((await admin.get(`${path}/${id}`).expect(200)).body.tags).toEqual([
        expect.objectContaining({ id: tag }),
      ]);
      const listed = (await admin.get(`${path}?tag=${tag}`).expect(200)).body
        .items as { id: string }[];
      expect(listed.map((item) => item.id)).toEqual([id]);
    });
  }

  if (has('comments')) {
    it('takes comments', async () => {
      const admin = node().admin();
      const id = await make();
      await admin
        .post(`${path}/${id}/comments`)
        .send({ body: 'Looks good.' })
        .expect(201);
      expect(
        (await admin.get(`${path}/${id}/comments`).expect(200)).body.items,
      ).toHaveLength(1);
    });
  }

  if (has('attachments')) {
    it('takes attachments', async () => {
      const admin = node().admin();
      const id = await make();
      await admin
        .post(`${path}/${id}/attachments`)
        .attach('file', Buffer.from('Minutes.\n'), {
          filename: 'minutes.txt',
          contentType: 'text/plain',
        })
        .expect(201);
      expect(
        (await admin.get(`${path}/${id}/attachments`).expect(200)).body.items,
      ).toHaveLength(1);
    });
  }

  if (has('revisions')) {
    it('keeps its revisions, and restores one', async () => {
      const admin = node().admin();
      const id = await make();
      await admin.patch(`${path}/${id}`).send(samples.changed).expect(200);
      expect(
        (await admin.get(`${path}/${id}/revisions`).expect(200)).body.items,
      ).toHaveLength(2);
      await admin.post(`${path}/${id}/revisions/1/restore`).expect(200);
    });
  }

  if (has('pdf')) {
    it('asks for a PDF (unavailable without Gotenberg: GOTENBERG_URL)', async () => {
      const admin = node().admin();
      const id = await make();
      const res = await admin
        .post(`${path}/${id}/pdf`)
        .set('Idempotency-Key', randomUUID())
        .expect(503);
      expect(res.body.code).toBe('documents_unavailable');
    });
  }

  if (has('bulk')) {
    it('deletes many at once', async () => {
      const admin = node().admin();
      const id = await make();
      const res = await admin
        .post(`${path}/bulk`)
        .set('Idempotency-Key', randomUUID())
        .send({ action: 'delete', ids: [id] })
        .expect(200);
      expect(res.body.done).toBe(1);
      await admin.get(`${path}/${id}`).expect(404);
    });
  }

  if (has('watch')) {
    it('is watched, and unwatched', async () => {
      const admin = node().admin();
      const id = await make();
      expect(
        (await admin.post(`${path}/${id}/watch`).expect(200)).body,
      ).toEqual({ watching: true });
      await admin.delete(`${path}/${id}/watch`).expect(204);
    });
  }

  if (has('search')) {
    it('is found by its words', async () => {
      const admin = node().admin();
      const id = await make();
      const word = searchableFields(record.fields)[0]!;
      const found = (await admin.get(`${path}?q=${word}`).expect(200)).body
        .items as { id: string }[];
      expect(found.map((item) => item.id)).toContain(id);
    });
  }
}
