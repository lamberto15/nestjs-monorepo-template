import { StorageDisk } from '@nestjs/storage';
import { eq } from 'drizzle-orm';
import { users } from '../src/iam/iam.tables.js';
import { AccountDeletionJob } from '../src/platform/account/account-deletion.job.js';
import { accountFileKey } from '../src/platform/storage/storage.config.js';
import { bootApp, type TestApp } from './support.js';

// A small limit, so the test of it sends 1 MB (read when AppModule loads).
vi.hoisted(() => {
  process.env.AVATAR_MAX_MB = '1';
});

/** The path and query of a signed URL: the tests reach the app on its own port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('0000000d49484452000000010000000108060000001f15c489', 'hex'),
]);
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n');

/** PUT /v1/account/avatar and friends (docs/attachments.md, "Avatars"). */
describe('user avatars (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  it('sets, shows, replaces and removes the picture; members see it by avatarUrl', async () => {
    const ada = await node.user([]);
    const bob = await node.user([]);
    expect(
      (await ada.agent.get('/v1/auth/me').expect(200)).body.user.avatarUrl,
    ).toBeNull();

    const set = await ada.agent
      .put('/v1/account/avatar')
      .attach('file', PNG, { filename: 'me.png', contentType: 'image/png' })
      .expect(200);
    expect(set.body.avatarUrl).toMatch(
      new RegExp(`^/v1/people/${ada.id}/avatar\\?v=`),
    );
    const me = await ada.agent.get('/v1/auth/me').expect(200);
    expect(me.body.user.avatarUrl).toBe(set.body.avatarUrl);

    // Another member of the tenant sees it: in the directory, by key, and by
    // its address, which answers with the image itself (an <img> follows no
    // redirect to another origin: not in `pnpm dev`, not to a bucket under
    // the shipped Content-Security-Policy).
    const found = await bob.agent
      .get(`/v1/people?key=user:${ada.id}`)
      .expect(200);
    expect(found.body.items[0].avatarUrl).toBe(set.body.avatarUrl);
    const shown = await bob.agent
      .get(set.body.avatarUrl)
      .buffer(true)
      // supertest parses only text and JSON: read the image's bytes.
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(shown.headers.location).toBeUndefined();
    expect(shown.headers['content-type']).toMatch(/^image\/png/);
    expect(shown.headers['content-disposition']).toMatch(/^inline/);
    expect(shown.headers['cache-control']).toMatch(/^private/);
    expect(shown.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(shown.body as Buffer, PNG)).toBe(0);
    // Anyone not signed in gets nothing.
    await node.http().get(set.body.avatarUrl).expect(401);

    // A new picture is a new address, and the old file goes.
    const db = node.db;
    const [{ avatarKey: first }] = await db
      .select({ avatarKey: users.avatarKey })
      .from(users)
      .where(eq(users.id, ada.id));
    const replaced = await ada.agent
      .put('/v1/account/avatar')
      .attach('file', JPEG, { filename: 'me.jpg', contentType: 'image/jpeg' })
      .expect(200);
    expect(replaced.body.avatarUrl).not.toBe(set.body.avatarUrl);
    const disk = node.app.get(StorageDisk);
    expect(await disk.exists(first!)).toBe(false);

    // Removing it clears the address, the file and the key; again is nothing.
    const [{ avatarKey: second }] = await db
      .select({ avatarKey: users.avatarKey })
      .from(users)
      .where(eq(users.id, ada.id));
    await ada.agent.delete('/v1/account/avatar').expect(204);
    await ada.agent.delete('/v1/account/avatar').expect(204);
    expect(await disk.exists(second!)).toBe(false);
    expect(
      (await ada.agent.get('/v1/auth/me').expect(200)).body.user.avatarUrl,
    ).toBeNull();
    await bob.agent.get(replaced.body.avatarUrl).expect(404);
  });

  it("is for the tenant's members: a user of another tenant gets the 404 of a person with no picture", async () => {
    const ada = await node.user([]);
    const bare = await node.user([]);
    const set = await ada.agent
      .put('/v1/account/avatar')
      .attach('file', PNG, { filename: 'me.png', contentType: 'image/png' })
      .expect(200);
    const outsider = await (await node.otherTenant()).user([]);

    // Ours see it; theirs get a 404, the same one as for a member who has none.
    await ada.agent.get(set.body.avatarUrl).expect(200);
    const refused = await outsider.agent.get(set.body.avatarUrl).expect(404);
    const none = await ada.agent
      .get(`/v1/people/${bare.id}/avatar`)
      .expect(404);
    expect(refused.body.code).toBe(none.body.code);
    expect(refused.body.detail).toBe(none.body.detail);
  });

  it('reads the type from the bytes and caps the size', async () => {
    const ada = await node.user([]);
    // A PDF, text, and a "PNG" that is not.
    await ada.agent
      .put('/v1/account/avatar')
      .attach('file', PDF, {
        filename: 'x.pdf',
        contentType: 'application/pdf',
      })
      .expect(415);
    await ada.agent
      .put('/v1/account/avatar')
      .attach('file', Buffer.from('<svg onload="alert(1)"/>'), {
        filename: 'x.svg',
        contentType: 'image/svg+xml',
      })
      .expect(415);
    await ada.agent
      .put('/v1/account/avatar')
      .attach('file', Buffer.from('not an image at all'), {
        filename: 'x.png',
        contentType: 'image/png',
      })
      .expect(415);
    // A JPEG declared as a PNG.
    await ada.agent
      .put('/v1/account/avatar')
      .attach('file', JPEG, { filename: 'x.png', contentType: 'image/png' })
      .expect(415);
    // Over AVATAR_MAX_MB (1 here).
    await ada.agent
      .put('/v1/account/avatar')
      .attach('file', Buffer.concat([PNG, Buffer.alloc(1024 * 1024 + 1)]), {
        filename: 'big.png',
        contentType: 'image/png',
      })
      .expect(413);
    await ada.agent.put('/v1/account/avatar').expect(400);
    expect(
      (await ada.agent.get('/v1/auth/me').expect(200)).body.user.avatarUrl,
    ).toBeNull();
  });

  it('is the person’s own: not while acting as them, not for a signed-out caller', async () => {
    const ada = await node.user([]);
    await node
      .http()
      .put('/v1/account/avatar')
      .attach('file', PNG, { filename: 'me.png', contentType: 'image/png' })
      .expect(401);
    const admin = await node.signIn(
      process.env.ADMIN_EMAIL!,
      process.env.ADMIN_PASSWORD!,
    );
    await admin.post(`/v1/access/users/${ada.id}/impersonate`).expect(204);
    await admin
      .put('/v1/account/avatar')
      .attach('file', PNG, { filename: 'me.png', contentType: 'image/png' })
      .expect(403);
    await admin.delete('/v1/account/avatar').expect(403);
    expect(
      (await ada.agent.get('/v1/auth/me').expect(200)).body.user.avatarUrl,
    ).toBeNull();
  });

  it('is part of the account export and goes with the account', async () => {
    const ada = await node.user([]);
    const set = await ada.agent
      .put('/v1/account/avatar')
      .attach('file', PNG, { filename: 'me.png', contentType: 'image/png' })
      .expect(200);
    expect(set.body.avatarUrl).toBeTruthy();
    const [{ avatarKey }] = await node.db
      .select({ avatarKey: users.avatarKey })
      .from(users)
      .where(eq(users.id, ada.id));
    const disk = node.app.get(StorageDisk);
    expect(await disk.exists(avatarKey!)).toBe(true);
    // An earlier picture whose delete failed (dispose() only logs it): an
    // orphan under the account's prefix, which no key points at.
    const orphan = accountFileKey(ada.id, 'avatar/orphan.png');
    await disk.put(orphan, PNG, { contentType: 'image/png' });

    const started = await ada.agent
      .post('/v1/account/export')
      .send({})
      .expect(202);
    let status: Record<string, any> = {};
    for (let tries = 0; tries < 100; tries++) {
      status = (
        await ada.agent.get(`/v1/data/transfers/${started.body.id}`).expect(200)
      ).body;
      if (['completed', 'failed'].includes(status.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status.status).toBe('completed');
    const rows = (await node.http().get(local(status.result.url)).expect(200))
      .body as { kind: string; data: Record<string, unknown> }[];
    expect(rows.find((row) => row.kind === 'profile')?.data.avatarKey).toBe(
      avatarKey,
    );

    await ada.agent
      .post('/v1/account/deletion')
      .send({ password: ada.password })
      .expect(200);
    await node.app
      .get(AccountDeletionJob)
      .run(new Date(Date.now() + 15 * 86_400_000));
    expect(await disk.exists(avatarKey!)).toBe(false);
    expect(await disk.exists(orphan)).toBe(false);
    const [row] = await node.db
      .select({ avatarKey: users.avatarKey })
      .from(users)
      .where(eq(users.id, ada.id));
    expect(row!.avatarKey).toBeNull();
  });
});
