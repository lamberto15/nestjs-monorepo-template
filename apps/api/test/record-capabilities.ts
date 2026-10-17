import { randomUUID } from 'node:crypto';
import {
  fieldSamples,
  searchableFields,
} from '../src/platform/fields/fields.js';
import {
  numberFormat,
  type RecordDeclaration,
  recordKey,
} from '../src/platform/records/record.js';
import { type TestApp, webhookReceiver } from './support.js';

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
  if (has('events')) {
    it('sends its changes as webhooks to the API client that owns it', async () => {
      const receiver = await webhookReceiver();
      try {
        const key = recordKey(record);
        const client = await node().client();
        await node()
          .http()
          .post('/v1/webhook-endpoints')
          .set('Authorization', client.auth)
          .send({ url: receiver.url, eventTypes: ['*'] })
          .expect(201);
        const own = node().http();
        const created = await own
          .post(path)
          .set('Authorization', client.auth)
          .set('Idempotency-Key', randomUUID())
          .send(samples.body())
          .expect(201);
        const id = created.body.id as string;
        // A user's record has no client to tell: nothing is sent for it.
        await make();
        await own
          .patch(`${path}/${id}`)
          .set('Authorization', client.auth)
          .send(samples.changed)
          .expect(200);
        await own
          .delete(`${path}/${id}`)
          .set('Authorization', client.auth)
          .expect(204);
        if (record.softDelete) {
          await own
            .post(`${path}/${id}/restore`)
            .set('Authorization', client.auth)
            .expect(200);
        }
        await node().deliverWebhooks();

        expect(receiver.received.map((hook) => hook.body.type)).toEqual([
          `${key}.created`,
          `${key}.updated`,
          `${key}.deleted`,
          ...(record.softDelete ? [`${key}.restored`] : []),
        ]);
        // The data is the record as the API shows it.
        expect(receiver.received[0]!.body.data).toMatchObject({
          id,
          ownerId: created.body.ownerId,
        });
        expect(receiver.received[1]!.body.data[samples.changedField]).toEqual(
          samples.changed[samples.changedField],
        );
        expect(receiver.received[0]!.headers['webhook-signature']).toMatch(
          /^v1,/,
        );
      } finally {
        await receiver.close();
      }
    });
  }

  if (has('numbered')) {
    it('numbers its records, gapless, and lists by number', async () => {
      const admin = node().admin();
      const { prefix, perYear, width } = numberFormat(record);
      const created = [];
      for (let i = 0; i < 2; i++) {
        created.push(
          (
            await admin
              .post(path)
              .set('Idempotency-Key', randomUUID())
              .send(samples.body())
              .expect(201)
          ).body as { id: string; number: string },
        );
      }
      const [first, second] = created as [
        (typeof created)[0],
        (typeof created)[0],
      ];
      const format = new RegExp(
        `^${prefix}-${perYear ? '\\d{4}-' : ''}\\d{${width}}$`,
      );
      expect(first.number).toMatch(format);
      expect(Number(second.number.slice(-width))).toBe(
        Number(first.number.slice(-width)) + 1,
      );
      // Read-only: a change can't renumber it.
      const changed = await admin
        .patch(`${path}/${first.id}`)
        .send({ ...samples.changed, number: 'X-1' });
      expect(changed.status).toBe(200); // ignored, not applied
      expect(
        (await admin.get(`${path}/${first.id}`).expect(200)).body.number,
      ).toBe(first.number);
      // Filtered and sorted by it.
      const found = (
        await admin
          .get(`${path}?number=${encodeURIComponent(second.number)}`)
          .expect(200)
      ).body.items as { id: string }[];
      expect(found.map((item) => item.id)).toEqual([second.id]);
      const sorted = (
        await admin.get(`${path}?sort=-number&limit=2`).expect(200)
      ).body.items as { id: string }[];
      expect(sorted.map((item) => item.id)).toEqual([second.id, first.id]);
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
}
