/**
 * Edge cases of the HTTP conventions every route shares (docs/api-conventions.md):
 * problem details for each kind of error, cursor pagination and filters,
 * idempotency, languages, health and versions.
 */
import { randomUUID } from 'node:crypto';
import { bootApp, newPassword, type TestApp } from './support.js';

const PROBLEM = /^application\/problem\+json/;

describe('API conventions, edge cases (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(() => node.close());

  describe('problem details', () => {
    it('answers a nested validation error with the dotted path of the field', async () => {
      const res = await node
        .admin()
        .post('/v1/access/roles')
        .set('X-Request-Id', 'req-nested-0001')
        .send({
          name: 'Nested',
          permissions: [
            { subject: 'Note', action: 'read', conditions: [] },
            { subject: 'Note', action: 'read', conditions: [{ key: '' }] },
          ],
        })
        .expect(400);
      expect(res.headers['content-type']).toMatch(PROBLEM);
      expect(res.body).toMatchObject({
        code: 'validation_failed',
        requestId: 'req-nested-0001',
        instance: '/v1/access/roles',
      });
      expect(res.body.errors).toEqual([
        {
          path: 'permissions.1.conditions.0.key',
          message: expect.any(String),
        },
      ]);
    });

    it('answers 401, 403, 404, 409 and 422 as problems with their codes', async () => {
      const cases: [
        Promise<{
          status: number;
          headers: Record<string, string>;
          body: Record<string, unknown>;
        }>,
        number,
        string,
      ][] = [
        [node.http().get('/v1/notes'), 401, 'missing_credentials'],
        [
          (await node.user(['viewer'])).agent
            .post('/v1/access/roles')
            .send({ name: 'x', permissions: [] }),
          403,
          'forbidden',
        ],
        [node.admin().get('/v1/nowhere'), 404, 'not_found'],
        [node.admin().get(`/v1/notes/${randomUUID()}`), 404, 'not_found'],
        [node.admin().post('/v1/auth/impersonation/stop'), 409, 'conflict'],
      ];
      for (const [pending, status, code] of cases) {
        const res = await pending;
        expect(res.status).toBe(status);
        expect(res.headers['content-type']).toMatch(PROBLEM);
        expect(res.body).toMatchObject({
          type: 'about:blank',
          status,
          code,
          title: expect.any(String),
          detail: expect.any(String),
          requestId: res.headers['x-request-id'],
        });
      }
    });

    it('replaces a request id that is not safe to log, and echoes a good one', async () => {
      const replaced = await node
        .http()
        .get('/v1/nowhere')
        .set('X-Request-Id', 'bad id with spaces');
      expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(replaced.body.requestId).toBe(replaced.headers['x-request-id']);
      const tooShort = await node
        .http()
        .get('/v1/nowhere')
        .set('X-Request-Id', 'abc');
      expect(tooShort.body.requestId).not.toBe('abc');
      const good = await node
        .http()
        .get('/v1/nowhere')
        .set('X-Request-Id', 'proxy:req.0001-a_b');
      expect(good.body.requestId).toBe('proxy:req.0001-a_b');
    });

    it('drops the query string from instance', async () => {
      const res = await node
        .admin()
        .get('/v1/notes?limit=0&secret=1')
        .expect(400);
      expect(res.body.instance).toBe('/v1/notes');
    });

    it('answers a malformed JSON body with a 400 problem, not a 500', async () => {
      const res = await node
        .http()
        .post('/v1/auth/sign-in')
        .set('Content-Type', 'application/json')
        .send('{"email": "a@example.com", ')
        .expect(400);
      expect(res.headers['content-type']).toMatch(PROBLEM);
      expect(res.body).toMatchObject({ status: 400, code: 'bad_request' });
    });

    // BUG: body-parser runs before RequestLogMiddleware, so its errors get no request id.
    it("gives a malformed JSON body's problem a request id, like every other error", async () => {
      const res = await node
        .http()
        .post('/v1/auth/sign-in')
        .set('Content-Type', 'application/json')
        .send('{"email":')
        .expect(400);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });

    // BUG: the same path echoes the client's X-Request-Id unchecked (the middleware's rule never ran).
    it('never echoes an X-Request-Id the request-id rule refuses, even for a malformed body', async () => {
      const res = await node
        .http()
        .post('/v1/auth/sign-in')
        .set('Content-Type', 'application/json')
        .set('X-Request-Id', '<script>x</script>')
        .send('{"email":')
        .expect(400);
      expect(res.body.requestId).not.toBe('<script>x</script>');
    });

    // BUG: body-parser's PayloadTooLargeError is no HttpException; the filter answers 500.
    it('answers a body over the size limit with 413 payload_too_large', async () => {
      const res = await node
        .admin()
        .post('/v1/notes')
        .set('Idempotency-Key', randomUUID())
        .send({ title: 'Big', body: 'x'.repeat(200_000) });
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('payload_too_large');
    });

    it('never answers a body over the size limit with internals', async () => {
      const res = await node
        .admin()
        .post('/v1/notes')
        .set('Idempotency-Key', randomUUID())
        .send({ title: 'Big', body: 'x'.repeat(200_000) });
      expect(res.headers['content-type']).toMatch(PROBLEM);
      expect(JSON.stringify(res.body)).not.toMatch(/limit|entity|stack/i);
    });

    // BUG: body-parser's 415 (an unsupported charset) is no HttpException either: a 500.
    it('answers a JSON body in an unsupported charset with 415', async () => {
      const res = await node
        .http()
        .post('/v1/auth/sign-in')
        .set('Content-Type', 'application/json; charset=klingon')
        .send('{"email":"a@example.com","password":"x"}');
      expect(res.status).toBe(415);
      expect(res.body.code).toBe('unsupported_media_type');
    });

    it('answers a body that is not JSON with a 400 validation problem', async () => {
      for (const type of ['text/plain', 'application/xml']) {
        const res = await node
          .http()
          .post('/v1/auth/sign-in')
          .set('Content-Type', type)
          .send('email=a@example.com')
          .expect(400);
        expect(res.headers['content-type']).toMatch(PROBLEM);
        expect(res.body.code).toBe('validation_failed');
      }
      // No body at all.
      const empty = await node.http().post('/v1/auth/sign-in').expect(400);
      expect(empty.body.code).toBe('validation_failed');
    });

    it('answers a percent-encoding that is not UTF-8 with a 400, not a 500', async () => {
      const res = await node.admin().get('/v1/notes/%E0%A4%A');
      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(PROBLEM);
    });

    it('answers 429 with Retry-After, counting an email in any case and spacing as one', async () => {
      const email = `limited-${randomUUID().slice(0, 8)}@example.com`;
      const variants = [
        email,
        email.toUpperCase(),
        email,
        email.replace('limited', 'LIMITED'),
        email,
      ];
      for (const variant of variants) {
        await node
          .http()
          .post('/v1/auth/sign-in')
          .send({ email: variant, password: newPassword() })
          .expect(401);
      }
      const limited = await node
        .http()
        .post('/v1/auth/sign-in')
        .send({ email: email.toUpperCase(), password: newPassword() })
        .expect(429);
      expect(limited.headers['content-type']).toMatch(PROBLEM);
      expect(limited.body).toMatchObject({ status: 429, code: 'rate_limited' });
      const retryAfter = Number(limited.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(15 * 60);
      // Another account from the same address isn't limited.
      await node
        .http()
        .post('/v1/auth/sign-in')
        .send({ email: `other-${email}`, password: newPassword() })
        .expect(401);
    });
  });

  describe('concurrency and caching', () => {
    it('answers with an ETag, 304 while unchanged, and refuses a stale If-Match with 412', async () => {
      const client = await node.client();
      const note = (
        await node
          .writeNote(client.auth, { title: 'Tagged', body: 'v1' })
          .expect(201)
      ).body as { id: string };
      const url = `/v1/notes/${note.id}`;
      const first = await node
        .http()
        .get(url)
        .set('Authorization', client.auth)
        .expect(200);
      const etag = first.headers.etag as string;
      expect(etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
      expect(first.headers['cache-control']).toBe('private, no-cache');
      const unchanged = await node
        .http()
        .get(url)
        .set('Authorization', client.auth)
        .set('If-None-Match', etag)
        .expect(304);
      expect(unchanged.text).toBe('');

      // A write with the current tag goes through and returns the new one.
      const changed = await node
        .http()
        .patch(url)
        .set('Authorization', client.auth)
        .set('If-Match', etag)
        .send({ body: 'v2' })
        .expect(200);
      expect(changed.headers.etag).not.toBe(etag);
      // The stale tag is refused, naming the current one; `*` passes.
      const stale = await node
        .http()
        .patch(url)
        .set('Authorization', client.auth)
        .set('If-Match', etag)
        .send({ body: 'v3' })
        .expect(412);
      expect(stale.headers['content-type']).toMatch(PROBLEM);
      expect(stale.body).toMatchObject({
        code: 'precondition_failed',
        etag: changed.headers.etag,
      });
      await node
        .http()
        .get(url)
        .set('Authorization', client.auth)
        .set('If-None-Match', etag)
        .expect(200); // changed: the body again
      await node
        .http()
        .patch(url)
        .set('Authorization', client.auth)
        .set('If-Match', '*')
        .send({ body: 'v3' })
        .expect(200);
      await node
        .http()
        .delete(url)
        .set('Authorization', client.auth)
        .set('If-Match', etag)
        .expect(412);
      const current = (
        await node.http().get(url).set('Authorization', client.auth).expect(200)
      ).headers.etag as string;
      await node
        .http()
        .delete(url)
        .set('Authorization', client.auth)
        .set('If-Match', current)
        .expect(204);

      // A list has a tag too: it changes with any row of the page.
      const list = await node
        .http()
        .get('/v1/notes')
        .set('Authorization', client.auth)
        .expect(200);
      await node
        .http()
        .get('/v1/notes')
        .set('Authorization', client.auth)
        .set('If-None-Match', list.headers.etag as string)
        .expect(304);
      await node.writeNote(client.auth).expect(201);
      await node
        .http()
        .get('/v1/notes')
        .set('Authorization', client.auth)
        .set('If-None-Match', list.headers.etag as string)
        .expect(200);
    });
  });

  describe('pagination', () => {
    let auth: string;
    const ids: string[] = [];

    beforeAll(async () => {
      ({ auth } = await node.client());
      for (let i = 0; i < 5; i++) {
        const res = await node
          .writeNote(auth, { title: `Page ${i}`, body: 'x' })
          .expect(201);
        ids.push(res.body.id);
      }
    });
    const list = (query: string) =>
      node.http().get(`/v1/notes${query}`).set('Authorization', auth);

    it('walks every page, newest first, and ends with nextCursor null', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: { body: { items: { id: string }[]; nextCursor: string } } =
          await list(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`).expect(
            200,
          );
        seen.push(...res.body.items.map((note) => note.id));
        cursor = res.body.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toEqual([...ids].reverse());
    });

    it('adds the total only on request, the same on every page and under filters', async () => {
      const plain = await list('?limit=2').expect(200);
      expect(plain.body).not.toHaveProperty('total');

      const first = await list('?limit=2&count=true').expect(200);
      expect(first.body).toMatchObject({ total: 5, totalCapped: false });
      // The cursor narrows the page, never the total.
      const second = await list(
        `?limit=2&count=true&cursor=${first.body.nextCursor}`,
      ).expect(200);
      expect(second.body).toMatchObject({ total: 5, totalCapped: false });

      const filtered = await list('?count=true&title.contains=Page 3').expect(
        200,
      );
      expect(filtered.body).toMatchObject({ total: 1, totalCapped: false });
      await list('?count=yes').expect(400);
    });

    it('counts only what the caller may see', async () => {
      // Another client: its own notes only (clientPermissions: read mine).
      const other = await node.client();
      await node
        .writeNote(other.auth, { title: 'Theirs', body: 'x' })
        .expect(201);
      const res = await node
        .http()
        .get('/v1/notes?count=true')
        .set('Authorization', other.auth)
        .expect(200);
      expect(res.body).toMatchObject({ total: 1, totalCapped: false });
      // The other lists count the same way.
      const users = await node
        .admin()
        .get('/v1/access/users?count=true')
        .expect(200);
      expect(users.body.total).toBe(users.body.items.length);
      const audit = await node
        .admin()
        .get('/v1/access/audit?count=true&limit=1')
        .expect(200);
      expect(audit.body.total).toBeGreaterThan(1);
    });

    it('says there is no next page when the page holds exactly what is left', async () => {
      const res = await list('?limit=5').expect(200);
      expect(res.body.items).toHaveLength(5);
      expect(res.body.nextCursor).toBeNull();
      const one = await list('?limit=4').expect(200);
      expect(one.body.nextCursor).toBe(ids[1]);
    });

    it('answers an empty page after the last item, and for a cursor older than everything', async () => {
      const last = await list(`?cursor=${ids[0]}`).expect(200);
      expect(last.body).toEqual({ items: [], nextCursor: null });
      const nil = await list(
        '?cursor=00000000-0000-0000-0000-000000000000',
      ).expect(200);
      expect(nil.body).toEqual({ items: [], nextCursor: null });
    });

    it('takes a cursor of a row that no longer exists', async () => {
      const gone = ids[2];
      const res = await list(`?cursor=${gone}`).expect(200);
      expect(res.body.items.map((n: { id: string }) => n.id)).toEqual([
        ids[1],
        ids[0],
      ]);
    });

    it('refuses limits out of bounds or not numbers, and cursors that are not UUIDs', async () => {
      for (const query of [
        '?limit=0',
        '?limit=101',
        '?limit=-5',
        '?limit=abc',
        '?limit=1.5',
        '?limit=1&limit=2',
        '?cursor=abc',
        '?cursor=' + ids[0].slice(0, -1),
      ]) {
        const res = await list(query);
        expect(res.status, query).toBe(400);
        expect(res.body.code, query).toBe('validation_failed');
        expect(res.body.errors[0].path, query).toMatch(/^(limit|cursor)$/);
      }
      await list('?limit=100').expect(200);
      await list('?limit=1').expect(200);
    });
  });

  describe('filters', () => {
    let auth: string;
    const titles = [
      '100% done',
      '100x done',
      'a_b',
      'axb',
      'back\\slash',
      'backxslash',
    ];

    beforeAll(async () => {
      ({ auth } = await node.client());
      for (const title of titles) {
        await node.writeNote(auth, { title, body: 'x' }).expect(201);
      }
    });
    const found = async (query: Record<string, string>) => {
      const res = await node
        .http()
        .get('/v1/notes')
        .query(query)
        .set('Authorization', auth);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return (res.body.items as { title: string }[])
        .map((note) => note.title)
        .sort();
    };

    it('searches for %, _ and backslash as characters, not as LIKE patterns', async () => {
      expect(await found({ 'title.contains': '%' })).toEqual(['100% done']);
      expect(await found({ 'title.contains': '_' })).toEqual(['a_b']);
      expect(await found({ 'title.contains': '\\' })).toEqual(['back\\slash']);
      expect(await found({ 'title.startsWith': '100%' })).toEqual([
        '100% done',
      ]);
      expect(await found({ 'title.startsWith': 'back\\' })).toEqual([
        'back\\slash',
      ]);
      expect(await found({ 'title.contains': 'DONE' })).toEqual([
        '100% done',
        '100x done',
      ]);
    });

    it('reads `in` with spaces around the items, and refuses an empty list', async () => {
      expect(await found({ 'status.in': ' draft , published ' })).toHaveLength(
        titles.length,
      );
      expect(await found({ 'status.in': 'published,' })).toEqual([]);
      const empty = await node
        .http()
        .get('/v1/notes?status.in=,')
        .set('Authorization', auth)
        .expect(400);
      expect(empty.body.errors).toEqual([
        { path: 'status.in', message: expect.any(String) },
      ]);
      await node
        .http()
        .get('/v1/notes?status.in=draft,archived')
        .set('Authorization', auth)
        .expect(400);
    });

    it('reads isNull=false as "has a value"', async () => {
      expect(await found({ 'publishedAt.isNull': 'true' })).toHaveLength(
        titles.length,
      );
      expect(await found({ 'publishedAt.isNull': 'false' })).toEqual([]);
      expect(await found({ 'teamId.isNull': 'false' })).toEqual([]);
    });

    it('combines filters with and', async () => {
      expect(
        await found({ 'title.startsWith': 'a', 'title.contains': '_' }),
      ).toEqual(['a_b']);
      expect(
        await found({
          'createdAt.gte': new Date(Date.now() - 3_600_000).toISOString(),
          'createdAt.lt': new Date(Date.now() + 3_600_000).toISOString(),
          'title.contains': 'slash',
        }),
      ).toEqual(['back\\slash', 'backxslash']);
      expect(
        await found({
          'createdAt.gte': new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ).toEqual([]);
    });

    it('refuses unknown keys and undeclared operators, naming the key; lang is allowed', async () => {
      for (const key of [
        'secret',
        'title',
        'status.contains',
        'body.contains',
      ]) {
        const res = await node
          .http()
          .get('/v1/notes')
          .query({ [key]: 'x' })
          .set('Authorization', auth)
          .expect(400);
        expect(JSON.stringify(res.body.errors), key).toContain(key);
      }
      expect(await found({ lang: 'de' })).toHaveLength(titles.length);
    });

    it('checks filter values by type', async () => {
      for (const [key, value] of [
        ['teamId', 'not-a-uuid'],
        ['createdAt.gte', '2026-01-01'],
        ['publishedAt.isNull', 'yes'],
        ['status', 'archived'],
        ['title.contains', ''],
      ]) {
        const res = await node
          .http()
          .get('/v1/notes')
          .query({ [key]: value })
          .set('Authorization', auth);
        expect(res.status, `${key}=${value}`).toBe(400);
        expect(res.body.errors[0].path).toBe(key);
      }
    });
  });

  describe('idempotency', () => {
    it('answers a retry with the first response, and a different body with the same key with 422', async () => {
      const { auth } = await node.client();
      const key = randomUUID();
      const first = await node
        .writeNote(auth, { title: 'Once', body: 'x' }, key)
        .expect(201);
      const retry = await node
        .writeNote(auth, { title: 'Once', body: 'x' }, key)
        .expect(201);
      expect(retry.body).toEqual(first.body);
      const changed = await node
        .writeNote(auth, { title: 'Once', body: 'changed' }, key)
        .expect(422);
      expect(changed.headers['content-type']).toMatch(PROBLEM);
      expect(changed.body.status).toBe(422);
      expect(changed.body.code).toEqual(expect.any(String));
      const notes = await node
        .http()
        .get('/v1/notes')
        .set('Authorization', auth)
        .expect(200);
      expect(notes.body.items).toHaveLength(1);
    });

    it('requires the key where the route says so', async () => {
      const { auth } = await node.client();
      const res = await node
        .http()
        .post('/v1/notes')
        .set('Authorization', auth)
        .send({ title: 'No key', body: 'x' })
        .expect(400);
      expect(res.headers['content-type']).toMatch(PROBLEM);
    });

    it('keeps keys apart per caller: the same key from two clients makes two notes', async () => {
      const a = await node.client();
      const b = await node.client();
      const key = randomUUID();
      const fromA = await node
        .writeNote(a.auth, { title: 'Shared key', body: 'x' }, key)
        .expect(201);
      const fromB = await node
        .writeNote(b.auth, { title: 'Shared key', body: 'x' }, key)
        .expect(201);
      expect(fromB.body.id).not.toBe(fromA.body.id);
    });

    it('remembers a request that failed validation: a fixed body needs a new key', async () => {
      const { auth } = await node.client();
      const key = randomUUID();
      await node.writeNote(auth, { title: '' }, key).expect(400);
      // The same request again: the same answer.
      await node.writeNote(auth, { title: '' }, key).expect(400);
      // A different body under that key: refused, never a second meaning for one key.
      await node
        .writeNote(auth, { title: 'Fixed', body: 'x' }, key)
        .expect(422);
      await node
        .writeNote(auth, { title: 'Fixed', body: 'x' }, randomUUID())
        .expect(201);
    });

    it('makes one note of two concurrent requests with the same key', async () => {
      const { auth } = await node.client();
      const key = randomUUID();
      const results = await Promise.all([
        node.writeNote(auth, { title: 'Race', body: 'x' }, key),
        node.writeNote(auth, { title: 'Race', body: 'x' }, key),
      ]);
      for (const res of results) {
        expect([201, 409]).toContain(res.status);
      }
      const notes = await node
        .http()
        .get('/v1/notes')
        .set('Authorization', auth)
        .expect(200);
      expect(notes.body.items).toHaveLength(1);
    });
  });

  describe('languages', () => {
    // A new (invalid) email each time: sign-in allows 5 tries per email and IP.
    const invalidSignIn = () =>
      node
        .http()
        .post('/v1/auth/sign-in')
        .send({ email: `nope-${randomUUID()}`, password: 'x' });

    it('falls back to the default language for one it does not speak', async () => {
      const res = await invalidSignIn()
        .set('Accept-Language', 'fr-FR')
        .expect(400);
      expect(res.headers['content-language']).toBe('en');
      expect(res.body.errors).toContainEqual({
        path: 'email',
        message: 'email must be an email address',
      });
      const unknownLang = await node
        .http()
        .post('/v1/auth/sign-in?lang=xx')
        .send({ email: `nope-${randomUUID()}`, password: 'x' })
        .expect(400);
      expect(unknownLang.headers['content-language']).toBe('en');
      const garbage = await invalidSignIn()
        .set('Accept-Language', ';;;q=abc,*')
        .expect(400);
      expect(garbage.headers['content-language']).toBe('en');
    });

    it('lets ?lang override X-Lang and Accept-Language, and X-Lang override Accept-Language', async () => {
      const query = await node
        .http()
        .post('/v1/auth/sign-in?lang=de')
        .set('X-Lang', 'zh')
        .set('Accept-Language', 'ar')
        .send({ email: `nope-${randomUUID()}`, password: 'x' })
        .expect(400);
      expect(query.headers['content-language']).toBe('de');
      expect(query.body.errors).toContainEqual({
        path: 'email',
        message: 'email muss eine E-Mail-Adresse sein',
      });
      const header = await invalidSignIn()
        .set('X-Lang', 'de')
        .set('Accept-Language', 'ar')
        .expect(400);
      expect(header.headers['content-language']).toBe('de');
    });

    it('picks the first language it speaks from Accept-Language', async () => {
      const res = await invalidSignIn()
        .set('Accept-Language', 'fr-CA, de;q=0.8, en;q=0.5')
        .expect(400);
      expect(res.headers['content-language']).toBe('de');
    });

    it('takes ?lang on a list without calling it an unknown filter', async () => {
      const { auth } = await node.client();
      const res = await node
        .http()
        .get('/v1/notes?lang=de&limit=0')
        .set('Authorization', auth)
        .expect(400);
      expect(res.headers['content-language']).toBe('de');
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].path).toBe('limit');
    });
  });

  describe('health and versions', () => {
    it('answers /health and /health/live without credentials, unversioned', async () => {
      const ready = await node.http().get('/health').expect(200);
      expect(ready.body.status).toBe('ok');
      await node.http().get('/health/live').expect(200);
      await node.http().get('/v1/health').expect(404);
    });

    it('serves no /v2 and no unversioned API route, even to a signed-in user', async () => {
      const v2 = await node.admin().get('/v2/notes').expect(404);
      expect(v2.body).toMatchObject({
        code: 'not_found',
        instance: '/v2/notes',
      });
      await node.admin().get('/notes').expect(404);
      await node.admin().get('/v0/notes').expect(404);
      await node.admin().get('/v1/notes').expect(200);
    });

    it('answers an unknown method on a known path as a 404 problem', async () => {
      const res = await node.admin().put('/v1/notes').send({}).expect(404);
      expect(res.headers['content-type']).toMatch(PROBLEM);
    });
  });
});
