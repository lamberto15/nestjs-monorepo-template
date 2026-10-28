import { randomUUID } from 'node:crypto';
import { bootApp, type TestApp } from './support.js';

const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString();

/** The path and query of a signed URL: the tests reach the app on its own port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

describe('shares: read-only links to a record (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const item = async (body = { title: 'Plan', body: 'Secret text' }) =>
    (await node.writeItem(node.admin(), body).expect(201)).body as {
      id: string;
    };
  const share = (id: string, body: Record<string, unknown> = {}) =>
    node
      .admin()
      .post(`/v1/test-items/${id}/shares`)
      .send({ fields: ['title'], expiresAt: inDays(7), ...body });
  const open = (token: string, code?: string) =>
    node.http().post('/v1/shared/open').send({ token, code });

  it('shows exactly the shared fields without a sign-in, until revoked; audited without the token', async () => {
    const { id } = await item();
    const created = await share(id).expect(201);
    const token = created.body.token as string;
    expect(token).toMatch(/^shr_[0-9a-f-]{36}_[\w-]{43}$/);
    expect(created.body.url).toMatch(/\/shared#shr_/);

    const shown = await open(token).expect(200);
    expect(shown.body).toEqual({
      subject: 'TestItem',
      fields: { title: 'Plan' },
      files: [],
      expiresAt: created.body.expiresAt,
    });
    // Forged, tampered or empty: the same 404.
    await open(`${token.slice(0, -1)}A`).expect(404);
    await open('shr_nope').expect(404);

    const listed = await node
      .admin()
      .get(`/v1/test-items/${id}/shares`)
      .expect(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({ views: 1, active: true });
    expect(JSON.stringify(listed.body)).not.toContain(token);

    await node
      .admin()
      .delete(`/v1/test-items/${id}/shares/${created.body.id}`)
      .expect(204);
    // Revoked: refused at once, as a forged link is.
    const refused = await open(token).expect(404);
    expect(refused.body.code).toBe('share_not_found');

    const entries = [
      ...(await node.auditEntries({ action: 'share.created' })),
      ...(await node.auditEntries({ action: 'share.opened' })),
      ...(await node.auditEntries({ action: 'share.revoked' })),
    ];
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'share.created',
      'share.opened',
      'share.revoked',
    ]);
    expect(JSON.stringify(entries)).not.toContain(token.split('_')[2]);
  });

  it('refuses fields, expiries and sharers it should, and ends with its record or its maker', async () => {
    const { id } = await item();
    // A field the record has not, an expiry in the past or too far.
    await share(id, { fields: ['ownerId'] }).expect(400);
    await share(id, { expiresAt: inDays(-1) }).expect(400);
    await share(id, { expiresAt: inDays(31) }).expect(400);
    // An editor may read their own items but share none: no role grants it.
    const editor = await node.user(['editor']);
    const own = (
      await node.writeItem(editor.agent, { title: 'Mine' }).expect(201)
    ).body as { id: string };
    await editor.agent
      .post(`/v1/test-items/${own.id}/shares`)
      .send({ fields: ['title'], expiresAt: inDays(1) })
      .expect(403);
    // Someone else's item they may not read: 404, as if missing.
    await editor.agent
      .post(`/v1/test-items/${id}/shares`)
      .send({ fields: ['title'], expiresAt: inDays(1) })
      .expect(404);
    // An API client shares nothing.
    const client = await node.client();
    await node
      .http()
      .post(`/v1/test-items/${id}/shares`)
      .set('Authorization', client.auth)
      .send({ fields: ['title'], expiresAt: inDays(1) })
      .expect(403);

    // A sharer whose role is taken away: their links stop.
    const role = (
      await node
        .admin()
        .post('/v1/access/roles')
        .send({
          name: `sharer-${randomUUID().slice(0, 8)}`,
          permissions: [
            { subject: 'TestItem', action: 'read', conditions: [] },
            { subject: 'TestItem', action: 'share', conditions: [] },
          ],
        })
        .expect(201)
    ).body.id as string;
    const sharer = await node.user([role]);
    const theirs = await sharer.agent
      .post(`/v1/test-items/${id}/shares`)
      .send({ fields: ['title', 'body'], expiresAt: inDays(1) })
      .expect(201);
    await open(theirs.body.token).expect(200);
    await node
      .admin()
      .patch(`/v1/access/users/${sharer.id}`)
      .send({ roleIds: [] })
      .expect(204);
    await open(theirs.body.token).expect(404);

    // The record in the recycle bin: every link to it stops.
    const created = await share(id).expect(201);
    await node.admin().delete(`/v1/test-items/${id}`).expect(204);
    await open(created.body.token).expect(404);
  });

  it('opens a link to a recipient only with the code mailed to them', async () => {
    const { id } = await item();
    const created = await share(id, {
      recipientEmail: 'Guest@Example.com',
    }).expect(201);
    expect(created.body.recipientEmail).toBe('guest@example.com');
    const token = created.body.token as string;
    expect((await open(token).expect(403)).body.code).toBe(
      'share_code_required',
    );

    await node.http().post('/v1/shared/code').send({ token }).expect(204);
    const mail = await node.waitForMail({ to: 'guest@example.com' });
    const code = /<strong>(\d{6})<\/strong>/.exec(mail.message.html!)![1]!;
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await open(token, wrong).expect(403)).body.code).toBe(
      'share_code_invalid',
    );
    const shown = await open(token, code).expect(200);
    expect(shown.body.fields).toEqual({ title: 'Plan' });
  });

  it('hands out file links only for the files it shares', async () => {
    const { id } = await item();
    const file = await node
      .admin()
      .post(`/v1/test-items/${id}/attachments`)
      .attach('file', Buffer.from('Minutes\n'), {
        filename: 'minutes.txt',
        contentType: 'text/plain',
      })
      .expect(201);
    const without = await share(id).expect(201);
    expect((await open(without.body.token).expect(200)).body.files).toEqual([]);
    await node
      .http()
      .post(`/v1/shared/files/${file.body.id}`)
      .send({ token: without.body.token })
      .expect(404);

    const withFiles = await share(id, { files: true }).expect(201);
    const shown = await open(withFiles.body.token).expect(200);
    expect(shown.body.files).toEqual([
      {
        id: file.body.id,
        name: 'minutes.txt',
        size: 8,
        contentType: 'text/plain',
      },
    ]);
    const link = await node
      .http()
      .post(`/v1/shared/files/${file.body.id}`)
      .send({ token: withFiles.body.token })
      .expect(200);
    await node.http().get(local(link.body.url)).expect(200);
    // Another record's file is not the link's to hand out.
    const other = await item({ title: 'Other', body: 'x' });
    const foreign = await node
      .admin()
      .post(`/v1/test-items/${other.id}/attachments`)
      .attach('file', Buffer.from('Other\n'), {
        filename: 'other.txt',
        contentType: 'text/plain',
      })
      .expect(201);
    await node
      .http()
      .post(`/v1/shared/files/${foreign.body.id}`)
      .send({ token: withFiles.body.token })
      .expect(404);
  });
});
