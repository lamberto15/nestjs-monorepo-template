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
import { recordSchemas } from '../src/platform/records/record.schemas.js';
import {
  actionPath,
  approvalFlagKey,
} from '../src/platform/records/record-approvals.js';
import { recordSettingKey } from '../src/platform/records/record-settings.js';
import { problemFor, type TestApp, webhookReceiver } from './support.js';

const lowerFirst = (text: string) =>
  text.charAt(0).toLowerCase() + text.slice(1);

/**
 * The tests of each capability a record declares (platform/records), and of
 * its recycle bin (`softDelete`) and units (`unit`), for a feature's e2e
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

  // What a record page needs (a client's form, its buttons): the same
  // representation and ETag from every route that answers the record, and
  // what the reader may do with it.
  describe('its record page', () => {
    const response = recordSchemas(record).response.strict();
    /** The answer is the documented schema, no more (no tenantId): strict. */
    const conforms = (body: unknown) => {
      const parsed = response.safeParse(body);
      expect(parsed.error?.issues ?? []).toEqual([]);
    };
    const STRONG = /^"[\w-]+"$/;

    it('answers a create with the strong ETag GET sends: If-Match on the next write needs no read', async () => {
      const admin = node().admin();
      const created = await admin
        .post(path)
        .set('Idempotency-Key', randomUUID())
        .send(samples.body())
        .expect(201);
      const id = created.body.id as string;
      const etag = created.headers.etag as string;
      expect(etag).toMatch(STRONG);
      conforms(created.body);
      expect(created.body).not.toHaveProperty('tenantId');
      const shown = await admin.get(`${path}/${id}`).expect(200);
      expect(shown.headers.etag).toBe(etag);
      expect(shown.body).toEqual(created.body);
      conforms(shown.body);
      await admin
        .patch(`${path}/${id}`)
        .set('If-Match', etag)
        .send(samples.changed)
        .expect(200);
      if (record.softDelete) {
        await admin.delete(`${path}/${id}`).expect(204);
        const restored = await admin.post(`${path}/${id}/restore`).expect(200);
        expect(restored.headers.etag).toBe(
          (await admin.get(`${path}/${id}`).expect(200)).headers.etag,
        );
      }
    });

    it('says what the reader may do with each record (?include=can), as its routes decide', async () => {
      const admin = node().admin();
      const id = await make();
      const plain = await admin.get(`${path}/${id}`).expect(200);
      expect(plain.body).not.toHaveProperty('can');
      const withCan = await admin.get(`${path}/${id}?include=can`).expect(200);
      conforms(withCan.body);
      expect(withCan.body.can).toEqual({
        update: true,
        delete: true,
        ...(record.softDelete && { restore: false }),
        // Documents are off here (no GOTENBERG_URL): POST …/pdf would be a 503.
        ...(has('pdf') && { issue: false }),
      });
      // `can` is about the reader, not the record: the same ETag, good for If-Match.
      expect(withCan.headers.etag).toBe(plain.headers.etag);
      // A list's too, whatever `fields` picks.
      const page = await admin
        .get(`${path}?include=can&fields=createdAt`)
        .expect(200);
      expect(
        page.body.items.find((item: { id: string }) => item.id === id),
      ).toEqual({
        id,
        createdAt: expect.any(String),
        can: withCan.body.can,
      });
      expect(
        (await admin.get(path).expect(200)).body.items[0],
      ).not.toHaveProperty('can');
      await admin.get(`${path}/${id}?include=everything`).expect(400);

      if (record.grants !== 'none') {
        // Another editor's record: the reader's own conditions (mine), as the 403s.
        const editor = await node().user(['editor']);
        const viewer = await node().user(['viewer']);
        const own = (
          await editor.agent
            .post(path)
            .set('Idempotency-Key', randomUUID())
            .send(samples.body())
            .expect(201)
        ).body.id as string;
        expect(
          (await editor.agent.get(`${path}/${own}?include=can`).expect(200))
            .body.can,
        ).toMatchObject({ update: true, delete: true });
        expect(
          (await viewer.agent.get(`${path}/${own}?include=can`).expect(200))
            .body.can,
        ).toMatchObject({ update: false, delete: false });
        await viewer.agent
          .patch(`${path}/${own}`)
          .send(samples.changed)
          .expect(403);
      }

      if (record.softDelete) {
        await admin.delete(`${path}/${id}`).expect(204);
        const bin = await admin
          .get(`${path}?deleted=true&include=can`)
          .expect(200);
        expect(
          bin.body.items.find((item: { id: string }) => item.id === id).can,
        ).toEqual({
          update: false,
          delete: false,
          restore: true,
          ...(has('pdf') && { issue: false }),
        });
      }
    });
  });

  if (record.grants !== 'none') {
    // A record the caller may not read is a 404 on every route, exactly the
    // one an id that doesn't exist gets: no route tells that it exists. One
    // they read but may not change stays a 403 (docs/permissions.md).
    it('hides a record the caller may not read: the 404 of a missing one, on every route', async () => {
      const writer = await node().user(['editor']);
      const other = await node().user(['editor']);
      const viewer = await node().user(['viewer']);
      const id = (
        await writer.agent
          .post(path)
          .set('Idempotency-Key', randomUUID())
          .send(samples.body())
          .expect(201)
      ).body.id as string;
      const missing = randomUUID();
      type Route = (id: string) => ReturnType<typeof other.agent.get>;
      const routes: Route[] = [
        (at) => other.agent.get(`${path}/${at}`),
        (at) => other.agent.patch(`${path}/${at}`).send(samples.changed),
        (at) => other.agent.delete(`${path}/${at}`),
        ...(has('tags')
          ? [
              (at: string) =>
                other.agent.put(`${path}/${at}/tags`).send({ tagIds: [] }),
            ]
          : []),
        ...(has('comments')
          ? [(at: string) => other.agent.get(`${path}/${at}/comments`)]
          : []),
        ...(has('attachments')
          ? [(at: string) => other.agent.get(`${path}/${at}/attachments`)]
          : []),
        ...(has('revisions')
          ? [(at: string) => other.agent.get(`${path}/${at}/revisions`)]
          : []),
        ...(has('watch')
          ? [(at: string) => other.agent.post(`${path}/${at}/watch`)]
          : []),
      ];
      for (const route of routes) {
        const hidden = await route(id).expect(404);
        const absent = await route(missing).expect(404);
        expect(problemFor(hidden.body, id)).toEqual(
          problemFor(absent.body, missing),
        );
      }
      // Read but not theirs to change: a 403, which tells them why.
      await viewer.agent.get(`${path}/${id}`).expect(200);
      await viewer.agent
        .patch(`${path}/${id}`)
        .send(samples.changed)
        .expect(403);
      await viewer.agent.delete(`${path}/${id}`).expect(403);
      if (has('tags')) {
        await viewer.agent
          .put(`${path}/${id}/tags`)
          .send({ tagIds: [] })
          .expect(403);
      }
      if (record.softDelete) {
        // In the recycle bin: one they may not restore is a 404 too.
        await writer.agent.delete(`${path}/${id}`).expect(204);
        const hidden = await other.agent
          .post(`${path}/${id}/restore`)
          .expect(404);
        const absent = await other.agent
          .post(`${path}/${missing}/restore`)
          .expect(404);
        expect(problemFor(hidden.body, id)).toEqual(
          problemFor(absent.body, missing),
        );
        await writer.agent.post(`${path}/${id}/restore`).expect(200);
      }
    });
  }

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

  if (record.unit && record.grants !== 'none') {
    it("belongs to its creator's unit: the unit's leads see it", async () => {
      const admin = node().admin();
      const unit = (
        await admin
          .post('/v1/access/organizational-units')
          .send({ type: 'team', name: `Unit ${randomUUID().slice(0, 8)}` })
          .expect(201)
      ).body.id as string;
      const writer = await node().user(['editor']);
      await admin
        .post(`/v1/access/organizational-units/${unit}/members`)
        .send({ userId: writer.id })
        .expect(201);
      const created = await writer.agent
        .post(path)
        .set('Idempotency-Key', randomUUID())
        .send(samples.body())
        .expect(201);
      expect(created.body.unitId).toBe(unit);
      const id = created.body.id as string;
      const lead = await node().user(['unit-lead']);
      await lead.agent.get(`${path}/${id}`).expect(404); // not theirs to read: as if missing
      await admin
        .post(`/v1/access/organizational-units/${unit}/members`)
        .send({ userId: lead.id, role: 'lead' })
        .expect(201);
      await lead.agent.get(`${path}/${id}`).expect(200);
    });
  } else if (!record.unit) {
    it('has no unit', async () => {
      const id = await make();
      expect(
        (await node().admin().get(`${path}/${id}`).expect(200)).body,
      ).not.toHaveProperty('unitId');
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
      // Not theirs to read: as if missing.
      await editor.agent.get(`${path}/${id}`).expect(404);
      await viewer.agent.get(`${path}/${id}`).expect(404);
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
        .expect(404); // not theirs to read: as if missing
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
        .expect(404); // not theirs to read: as if missing
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
    it('asks for a PDF (unavailable without Gotenberg: GOTENBERG_URL), and lists its documents', async () => {
      const admin = node().admin();
      const id = await make();
      const res = await admin
        .post(`${path}/${id}/pdf`)
        .set('Idempotency-Key', randomUUID())
        .expect(503);
      expect(res.body.code).toBe('documents_unavailable');
      expect(
        (await admin.get(`${path}/${id}/documents`).expect(200)).body,
      ).toEqual({ items: [], nextCursor: null });
      // No templates to offer while documents are off.
      expect(
        (await admin.get(`/v1/lists/${record.subject}`).expect(200)).body
          .documentTemplates,
      ).toBeNull();
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
  /**
   * An API client that can own records: with `clientAccess: 'own'` any;
   * otherwise one an administrator gave a role of its own records.
   */
  const ownerClient = async () => {
    if (record.clientAccess === 'own') return node().client();
    const actions = ['read', 'create', 'update', 'delete'].concat(
      record.softDelete ? ['restore'] : [],
    );
    const role = await node()
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `Own ${record.path} ${randomUUID().slice(0, 8)}`,
        permissions: actions.map((action) => ({
          subject: record.subject,
          action,
          conditions: action === 'create' ? [] : [{ key: 'mine' }],
        })),
      })
      .expect(201);
    const created = await node()
      .admin()
      .post('/v1/access/clients')
      .send({
        name: `client-${randomUUID().slice(0, 8)}`,
        roleIds: [role.body.id],
      })
      .expect(201);
    return {
      id: created.body.id as string,
      auth: `Bearer ${created.body.key}`,
    };
  };

  if (has('events')) {
    it('sends its changes as webhooks to the API client that owns it', async () => {
      const receiver = await webhookReceiver();
      try {
        const key = recordKey(record);
        const client = await ownerClient();
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

  // Its approvable actions (`approvals`): the route asks, the record waits, the effect runs.
  for (const [action, approval] of Object.entries(record.approvals ?? {})) {
    const route = (id: string) => `${path}/${id}/${actionPath(action)}`;
    const ask = (id: string) =>
      node().admin().post(route(id)).set('Idempotency-Key', randomUUID());
    const key = `${record.subject}.${action}`;

    if (approval.flag !== false) {
      it(`${action} runs at once while its approval is off`, async () => {
        const id = await make();
        const done = await ask(id).expect(200);
        expect(done.body).toEqual({ status: 'applied', approvalId: null });
        // Switched off for the tenant: the flag is declared, off by default.
        const flag = await node()
          .admin()
          .get(`/v1/settings/${approvalFlagKey(record, action)}`)
          .expect(200);
        expect(flag.body).toMatchObject({ value: false });
      });
    }

    it(`${action} asks for approval: the record waits, the effect runs once an approver says yes`, async () => {
      const admin = node().admin();
      if (approval.flag !== false) {
        await admin
          .put(`/v1/settings/${approvalFlagKey(record, action)}`)
          .send({ value: true })
          .expect(200);
      }
      // Editors decide (a stored version of the policy: the default names whoever may update).
      await admin
        .put(`/v1/approvals/policies/${key}`)
        .send({
          stages: [
            {
              name: 'Review',
              approvers: [{ type: 'role', role: 'editor' }],
              mode: { type: 'any' },
            },
          ],
        })
        .expect(200);
      const editor = await node().user(['editor']);
      const id = await make();

      const asked = await ask(id).expect(202);
      expect(asked.body).toMatchObject({ status: 'pending' });
      const approvalId = asked.body.approvalId as string;
      await node().worker.drain(); // the approval assigns the editors

      // Not twice, and not changed or deleted while it is decided.
      await ask(id).expect(409);
      const etag = (await admin.get(`${path}/${id}`).expect(200)).headers
        .etag as string;
      await admin
        .patch(`${path}/${id}`)
        .set('If-Match', etag)
        .send(samples.changed)
        .expect(409);
      await admin.delete(`${path}/${id}`).expect(409);

      await editor.agent
        .post(`/v1/approvals/${approvalId}/approve`)
        .send({})
        .expect(200);
      await node().worker.drain(); // the outcome's handler applies it
      expect(
        (await admin.get(`/v1/approvals/${approvalId}`).expect(200)).body
          .status,
      ).toBe('approved');
      // The record changes again once it is applied.
      await admin.delete(`${path}/${id}`).expect(204);
    });
  }

  // Its settings and flags (`settings`): declared under <path>.<name> with their defaults.
  const settings = Object.entries(record.settings ?? {});
  if (settings.length > 0) {
    it('declares its settings with their defaults', async () => {
      const admin = node().admin();
      for (const [name, spec] of settings) {
        const shown = await admin
          .get(`/v1/settings/${recordSettingKey(record, name)}`)
          .expect(200);
        expect(shown.body).toMatchObject({
          value: spec.initial,
          source: 'default',
        });
      }
    });
  }
}
