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

  if (record.team && record.grants !== 'none') {
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
  } else if (!record.team) {
    it('has no team', async () => {
      const id = await make();
      expect(
        (await node().admin().get(`${path}/${id}`).expect(200)).body,
      ).not.toHaveProperty('teamId');
    });
  }

  if (record.grants === 'none') {
    it('grants no seed role: only administrators, until someone grants it', async () => {
      const id = await make();
      const editor = await node().user(['editor']);
      const viewer = await node().user(['viewer']);
      await editor.agent
        .post(path)
        .set('Idempotency-Key', randomUUID())
        .send(samples.body())
        .expect(403);
      await editor.agent.get(`${path}/${id}`).expect(403);
      await viewer.agent.get(`${path}/${id}`).expect(403);
      await node().admin().get(`${path}/${id}`).expect(200);
    });
  }

  if (record.clientAccess === 'own') {
    it("lets an API client use its own records, not another client's", async () => {
      const client = await node().client();
      const other = await node().client();
      const created = await node()
        .http()
        .post(path)
        .set('Authorization', client.auth)
        .set('Idempotency-Key', randomUUID())
        .send(samples.body())
        .expect(201);
      const id = created.body.id as string;
      await node()
        .http()
        .get(`${path}/${id}`)
        .set('Authorization', client.auth)
        .expect(200);
      await node()
        .http()
        .get(`${path}/${id}`)
        .set('Authorization', other.auth)
        .expect(403);
    });
  } else {
    it('is closed to API clients: a role must grant it', async () => {
      const client = await node().client();
      const id = await make();
      await node()
        .http()
        .post(path)
        .set('Authorization', client.auth)
        .set('Idempotency-Key', randomUUID())
        .send(samples.body())
        .expect(403);
      await node()
        .http()
        .get(`${path}/${id}`)
        .set('Authorization', client.auth)
        .expect(403);
    });
  }

  if (record.idempotency) {
    describe(`Idempotency-Key: ${record.idempotency}`, () => {
      const post = (key?: string, sent = samples.body()) => {
        const call = node().admin().post(path);
        return (key ? call.set('Idempotency-Key', key) : call).send(sent);
      };
      /** The Idempotency-Key parameters of the record's routes in the OpenAPI document. */
      const headers = async () => {
        const document = (await node().http().get('/api-json').expect(200))
          .body;
        return Object.entries<
          Record<
            string,
            { parameters?: { name?: string; required?: boolean }[] }
          >
        >(document.paths)
          .filter(([route]) => route.startsWith(`${path}`))
          .flatMap(([, operations]) => Object.values(operations))
          .flatMap((operation) => operation.parameters ?? [])
          .filter((parameter) => parameter.name === 'Idempotency-Key');
      };

      if (record.idempotency === 'off') {
        it('takes no key: every create is a new record, and the document has no header', async () => {
          const key = randomUUID();
          const first = await post(key).expect(201);
          const second = await post(key).expect(201);
          expect(second.body.id).not.toBe(first.body.id);
          expect(await headers()).toEqual([]);
        });
      } else if (record.idempotency === 'optional') {
        it('creates without a key and replays one that is sent, the document says optional', async () => {
          await post().expect(201);
          const key = randomUUID();
          const sent = samples.body();
          const created = await post(key, sent).expect(201);
          expect((await post(key, sent).expect(201)).body.id).toBe(
            created.body.id,
          );
          const found = await headers();
          expect(found.length).toBeGreaterThan(0);
          expect(found.every((header) => header.required !== true)).toBe(true);
        });
      } else {
        it('refuses a create without a key, whatever the deployment says, the document says required', async () => {
          const refused = await post().expect(400);
          expect(refused.body).toMatchObject({
            code: 'IDEMPOTENCY_KEY_REQUIRED',
          });
          const found = await headers();
          expect(found.length).toBeGreaterThan(0);
          expect(found.every((header) => header.required === true)).toBe(true);
        });
      }
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
