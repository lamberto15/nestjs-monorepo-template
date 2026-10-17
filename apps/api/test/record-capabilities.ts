import { randomUUID } from 'node:crypto';
import {
  fieldSamples,
  searchableFields,
} from '../src/platform/fields/fields.js';
import type { RecordDeclaration } from '../src/platform/records/record.js';
import type { TestApp } from './support.js';

const lowerFirst = (text: string) =>
  text.charAt(0).toLowerCase() + text.slice(1);

/**
 * The tests of each capability a record declares (platform/records), for a
 * feature's e2e spec: `describeCapabilities(() => node, INVOICE)`. A
 * capability added to the declaration later is tested with no change to
 * the spec; records are made with the declaration's sample bodies.
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

  if (has('custom')) {
    it('takes custom fields: values checked on create and update, shown, filtered and sorted', async () => {
      const admin = node().admin();
      await admin
        .post('/v1/custom-fields')
        .send({
          subject: record.subject,
          key: 'region',
          label: 'Region',
          type: 'select',
          options: [
            { value: 'eu', label: 'Europe' },
            { value: 'us', label: 'Americas' },
          ],
          filterable: true,
          sortable: true,
        })
        .expect(201);
      await admin
        .post(path)
        .set('Idempotency-Key', randomUUID())
        .send({ ...samples.body(), custom: { region: 'asia' } })
        .expect(400);
      const created = await admin
        .post(path)
        .set('Idempotency-Key', randomUUID())
        .send({ ...samples.body(), custom: { region: 'eu' } })
        .expect(201);
      const id = created.body.id as string;
      expect(created.body.custom).toEqual({ region: 'eu' });
      expect(
        (
          await admin
            .patch(`${path}/${id}`)
            .send({ custom: { region: 'us' } })
            .expect(200)
        ).body.custom,
      ).toEqual({ region: 'us' });
      const listed = (
        await admin
          .get(`${path}?custom.region=us&sort=custom.region`)
          .expect(200)
      ).body.items as { id: string }[];
      expect(listed.map((item) => item.id)).toEqual([id]);
    });
  }

  const unique = Object.entries(record.fields).find(
    ([, f]) => f.options.unique,
  )?.[0];
  if (record.softDelete && unique) {
    it("frees a deleted record's unique value, and refuses to restore it once taken", async () => {
      const admin = node().admin();
      const body = samples.body();
      const create = (data: Record<string, unknown>) =>
        admin.post(path).set('Idempotency-Key', randomUUID()).send(data);
      const first = (await create(body).expect(201)).body.id as string;
      await admin.delete(`${path}/${first}`).expect(204);
      // The bin doesn't hold the value: a new record takes it.
      await create({ ...samples.body(), [unique]: body[unique] }).expect(201);
      const taken = await admin.post(`${path}/${first}/restore`).expect(409);
      expect(taken.body.code).toBe(`${lowerFirst(record.subject)}_taken`);
    });
  }
}
