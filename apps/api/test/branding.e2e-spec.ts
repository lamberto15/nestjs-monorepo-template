import { StorageDisk } from '@nestjs/storage';
import { randomUUID } from 'node:crypto';
import { BrandingService } from '../src/platform/branding/branding.service.js';
import { bootApp, type TestApp } from './support.js';

/** A PNG and a JPEG: what the logo's bytes must start with (the signature, then filler). */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'),
  Buffer.from([0xff, 0xd9]),
]);
const SVG = Buffer.from('<svg><script>alert(1)</script></svg>');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

/** The bytes of a response, whatever its type. */
const binary = (
  res: NodeJS.ReadableStream,
  done: (error: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

describe('tenant branding (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  it('starts unbranded, and a tenant’s administrator sets the colour and the sender name', async () => {
    const tenant = await node.otherTenant();
    expect((await tenant.admin.get('/v1/branding').expect(200)).body).toEqual({
      primaryColor: null,
      mailFromName: null,
      logoUrl: null,
      locked: false,
      canEdit: true,
    });
    const set = await tenant.admin
      .put('/v1/branding')
      .send({ primaryColor: '#0A84FF', mailFromName: 'Acme Support' })
      .expect(200);
    expect(set.body).toMatchObject({
      primaryColor: '#0A84FF',
      mailFromName: 'Acme Support',
    });
    // The values are the tenant's settings: audited as they are.
    expect(
      (await tenant.admin.get('/v1/settings/branding.primaryColor').expect(200))
        .body,
    ).toMatchObject({ value: '#0A84FF', source: 'tenant' });
    // Another tenant is unaffected.
    expect(
      (await node.admin().get('/v1/branding').expect(200)).body,
    ).toMatchObject({ primaryColor: null, mailFromName: null });
    // `null` removes one, an absent key stays.
    const cleared = await tenant.admin
      .put('/v1/branding')
      .send({ primaryColor: null })
      .expect(200);
    expect(cleared.body).toMatchObject({
      primaryColor: null,
      mailFromName: 'Acme Support',
    });
  });

  it.each([
    'red',
    'rgb(0,0,0)',
    '#fff',
    '#12345g',
    '#1234567',
    'url(https://evil.example/x.css)',
    '#000000;background:url(x)',
    '#000000\n',
    '#000000"><script>',
    'expression(alert(1))',
    '',
  ])('refuses the colour %j, here and in the settings API', async (bad) => {
    const tenant = await node.otherTenant();
    await tenant.admin
      .put('/v1/branding')
      .send({ primaryColor: bad })
      .expect(400);
    await tenant.admin
      .put('/v1/settings/branding.primaryColor')
      .send({ value: bad })
      .expect(400);
    expect(
      (await tenant.admin.get('/v1/branding').expect(200)).body.primaryColor,
    ).toBeNull();
  });

  it.each([
    'Evil\r\nBcc: victim@example.com',
    'Name <attacker@example.com>',
    '"quoted"',
    'a@b.c',
    'x‮y',
    '',
    '   ',
    'x'.repeat(61),
  ])('refuses the sender name %j', async (bad) => {
    const tenant = await node.otherTenant();
    await tenant.admin
      .put('/v1/branding')
      .send({ mailFromName: bad })
      .expect(400);
  });

  it('is for who manages settings; everyone signed in reads it', async () => {
    const tenant = await node.otherTenant();
    const member = await tenant.user(['editor']);
    await member.agent.get('/v1/branding').expect(200);
    expect(
      (await member.agent.get('/v1/branding').expect(200)).body.canEdit,
    ).toBe(false);
    await member.agent
      .put('/v1/branding')
      .send({ primaryColor: '#000000' })
      .expect(403);
    await member.agent
      .post('/v1/branding/logo')
      .attach('file', PNG, { filename: 'l.png', contentType: 'image/png' })
      .expect(403);
    await member.agent.delete('/v1/branding/logo').expect(403);
    await node.http().get('/v1/branding').expect(401);
  });

  describe('the logo', () => {
    it('is recognized by its bytes, served publicly, and replaced or removed', async () => {
      const tenant = await node.otherTenant();
      const first = await tenant.admin
        .post('/v1/branding/logo')
        .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' })
        .expect(201);
      expect(first.body.logoUrl).toBe(`/v1/branding/${tenant.id}/logo`);

      // No sign-in needed: a mail client shows it. The bytes, with the type
      // they say and the headers of a file that is never a page.
      const file = await node
        .http()
        .get(`/v1/branding/${tenant.id}/logo`)
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(file.headers['content-type']).toBe('image/png');
      expect(file.headers['x-content-type-options']).toBe('nosniff');
      expect(file.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
      expect(file.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(file.body).toEqual(PNG);

      // A new one replaces it, whatever the name says.
      await tenant.admin
        .post('/v1/branding/logo')
        .attach('file', JPEG, { filename: 'x.png', contentType: 'image/png' })
        .expect(201);
      const jpeg = await node
        .http()
        .get(`/v1/branding/${tenant.id}/logo`)
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(jpeg.headers['content-type']).toBe('image/jpeg');
      expect(jpeg.body).toEqual(JPEG);

      // Another tenant has none.
      await node.http().get(`/v1/branding/${node.tenantId}/logo`).expect(404);

      await tenant.admin.delete('/v1/branding/logo').expect(204);
      await node.http().get(`/v1/branding/${tenant.id}/logo`).expect(404);
      await tenant.admin.delete('/v1/branding/logo').expect(404);
      expect(
        (await tenant.admin.get('/v1/branding').expect(200)).body.logoUrl,
      ).toBeNull();
    });

    it.each([
      ['an SVG', SVG, 'logo.svg', 'image/svg+xml'],
      ['an SVG named .png', SVG, 'logo.png', 'image/png'],
      ['HTML named .png', HTML, 'logo.png', 'image/png'],
      ['text', Buffer.from('plain'), 'logo.txt', 'text/plain'],
      ['an empty file', Buffer.alloc(0), 'logo.png', 'image/png'],
    ])('refuses %s', async (_name, bytes, filename, contentType) => {
      const tenant = await node.otherTenant();
      await tenant.admin
        .post('/v1/branding/logo')
        .attach('file', bytes, { filename, contentType })
        .expect((res) => {
          expect([400, 415]).toContain(res.status);
        });
      await node.http().get(`/v1/branding/${tenant.id}/logo`).expect(404);
    });

    it('refuses a file over 512 KB and keeps the logo it has', async () => {
      const tenant = await node.otherTenant();
      await tenant.admin
        .post('/v1/branding/logo')
        .attach('file', PNG, { filename: 'l.png', contentType: 'image/png' })
        .expect(201);
      const big = Buffer.concat([PNG, Buffer.alloc(600 * 1024)]);
      await tenant.admin
        .post('/v1/branding/logo')
        .attach('file', big, { filename: 'big.png', contentType: 'image/png' })
        .expect(413);
      const kept = await node
        .http()
        .get(`/v1/branding/${tenant.id}/logo`)
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(kept.body).toEqual(PNG);
    });

    it('serves only what the bytes say is an image, whatever the file was stored as', async () => {
      const tenant = await node.otherTenant();
      // A file put on the key by other means (a restore, a bucket tool),
      // labelled as an image but holding a script.
      await node.app
        .get(StorageDisk)
        .put(BrandingService.logoKey(tenant.id), SVG, {
          contentType: 'image/png',
        });
      await node.http().get(`/v1/branding/${tenant.id}/logo`).expect(404);
      expect(
        (await tenant.admin.get('/v1/branding').expect(200)).body.logoUrl,
      ).toBeNull();
    });

    it('answers 404 for an id that is no tenant’s, and 400 for one that is no id', async () => {
      await node.http().get(`/v1/branding/${randomUUID()}/logo`).expect(404);
      await node.http().get('/v1/branding/..%2F..%2Fetc/logo').expect(400);
      await node.http().get('/v1/branding/not-an-id/logo').expect(400);
    });

    it('needs a file', async () => {
      const tenant = await node.otherTenant();
      await tenant.admin.post('/v1/branding/logo').expect(400);
    });
  });

  it('puts the tenant’s name, colour and logo in its mail', async () => {
    const tenant = await node.otherTenant();
    await tenant.admin
      .put('/v1/branding')
      .send({ primaryColor: '#0a84ff', mailFromName: 'Acme Support' })
      .expect(200);
    await tenant.admin
      .post('/v1/branding/logo')
      .attach('file', PNG, { filename: 'l.png', contentType: 'image/png' })
      .expect(201);

    const email = `invitee-${Date.now()}@example.com`;
    await node.invite(tenant.admin, { email, name: 'Invitee' });
    const mail = node.mailbox.assertSent({
      to: email,
      subject: /invited you to/,
    });
    expect(mail.from.name).toBe('Acme Support');
    expect(mail.html).toContain('border-top:4px solid #0a84ff');
    expect(mail.html).toContain(`/v1/branding/${tenant.id}/logo`);
    expect(mail.html).toContain('Acme Support');

    // Another tenant's mail is not branded.
    const plain = await node.otherTenant();
    const other = `plain-${Date.now()}@example.com`;
    await node.invite(plain.admin, { email: other, name: 'Plain' });
    const unbranded = node.mailbox.assertSent({
      to: other,
      subject: /invited you to/,
    });
    expect(unbranded.from.name).not.toBe('Acme Support');
    expect(unbranded.html).toContain('border-top:4px solid #1f2328');
    expect(unbranded.html).not.toContain('/v1/branding/');
  });

  describe('the operators’ lock', () => {
    it('freezes the tenant’s branding, through every way in, and lifts', async () => {
      const tenant = await node.otherTenant();
      await tenant.admin
        .put('/v1/branding')
        .send({ primaryColor: '#112233' })
        .expect(200);
      await tenant.admin
        .post('/v1/branding/logo')
        .attach('file', PNG, { filename: 'l.png', contentType: 'image/png' })
        .expect(201);

      // A tenant's administrator can't lock or unlock: the key takes no scope.
      await tenant.admin
        .put('/v1/settings/branding.locked')
        .send({ value: true })
        .expect(400);
      await tenant.admin
        .put('/v1/settings/branding.locked/platform')
        .send({ value: true })
        .expect(403);

      // The operators lock it for this tenant alone: a platform rule on its slug.
      await node
        .admin()
        .put('/v1/settings/branding.locked/platform')
        .send({
          value: false,
          rules: [
            {
              conditions: [
                { key: 'tenantSlug', params: { slugs: [tenant.slug] } },
              ],
              outcome: { value: true },
            },
          ],
        })
        .expect(200);
      try {
        const view = await tenant.admin.get('/v1/branding').expect(200);
        expect(view.body).toMatchObject({
          locked: true,
          canEdit: false,
          primaryColor: '#112233',
        });
        const refused = (res: { body: { code?: string } }) =>
          expect(res.body.code).toBe('branding_locked');
        await tenant.admin
          .put('/v1/branding')
          .send({ primaryColor: '#000000' })
          .expect(409)
          .expect(refused);
        await tenant.admin
          .put('/v1/settings/branding.primaryColor')
          .send({ value: '#000000' })
          .expect(409)
          .expect(refused);
        await tenant.admin
          .put('/v1/settings/branding.mailFromName')
          .send({ value: 'Mine' })
          .expect(409);
        await tenant.admin
          .delete('/v1/settings/branding.primaryColor')
          .expect(409);
        await tenant.admin
          .post('/v1/branding/logo')
          .attach('file', JPEG, {
            filename: 'l.jpg',
            contentType: 'image/jpeg',
          })
          .expect(409)
          .expect(refused);
        await tenant.admin.delete('/v1/branding/logo').expect(409);
        // What was stored stays in force, and the logo is still served.
        await node.http().get(`/v1/branding/${tenant.id}/logo`).expect(200);
        // Other tenants are free.
        const free = await node.otherTenant();
        await free.admin
          .put('/v1/branding')
          .send({ primaryColor: '#445566' })
          .expect(200);
      } finally {
        await node
          .admin()
          .delete('/v1/settings/branding.locked/platform')
          .expect(204);
      }
      await tenant.admin
        .put('/v1/branding')
        .send({ primaryColor: '#000000' })
        .expect(200);
    });

    it('can set the values instead: an enforced platform value beats the tenant’s', async () => {
      const tenant = await node.otherTenant();
      await tenant.admin
        .put('/v1/branding')
        .send({ primaryColor: '#112233' })
        .expect(200);
      await node
        .admin()
        .put('/v1/settings/branding.primaryColor/platform')
        .send({ value: '#abcdef', enforced: true })
        .expect(200);
      try {
        expect(
          (await tenant.admin.get('/v1/branding').expect(200)).body
            .primaryColor,
        ).toBe('#abcdef');
      } finally {
        await node
          .admin()
          .delete('/v1/settings/branding.primaryColor/platform')
          .expect(204);
      }
    });
  });

  it('records the changes in the audit log', async () => {
    const tenant = await node.otherTenant();
    await tenant.admin
      .post('/v1/branding/logo')
      .attach('file', PNG, { filename: 'l.png', contentType: 'image/png' })
      .expect(201);
    await tenant.admin.delete('/v1/branding/logo').expect(204);
    for (const action of ['branding.logo-changed', 'branding.logo-removed']) {
      const entries = await tenant.admin
        .get('/v1/access/audit')
        .query({ action })
        .expect(200);
      expect(entries.body.items).toHaveLength(1);
    }
  });
});
