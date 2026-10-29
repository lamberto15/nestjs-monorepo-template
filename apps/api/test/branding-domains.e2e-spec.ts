import { inflateRawSync } from 'node:zlib';
import { ConfigService } from '@nestjs/config';
import { randomInt, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type request from 'supertest';
import { vi } from 'vitest';
import { REDIS } from '../src/core/redis/redis.js';
import { BrandingDomainsJob } from '../src/platform/branding/branding-domains.job.js';
import { BrandingDomainsProcessor } from '../src/platform/branding/branding-domains.processor.js';
import { CUSTOM_DOMAINS_TXT_RESOLVER } from '../src/platform/branding/branding-domains.queue.js';
import { fakeDns, local, samlIdp } from './sso-support.js';
import { bootApp, type TestApp } from './support.js';

/** A hostname of this run: placeholders only (docs/branding.md). */
const host = () => `app-${randomUUID().slice(0, 8)}.example.com`;

const GENERIC = {
  primaryColor: null,
  darkPrimaryColor: null,
  mailFromName: null,
  logoUrl: null,
  darkLogoUrl: null,
};

/**
 * Custom domains (docs/branding.md, "Custom domains"): the hostname's
 * checks, its verification by a DNS TXT record and what a verified one
 * routes (the brand before sign-in, the session's tenant on that host, the
 * edge's TLS ask), the origins and cookies on it, and its end (removed, or
 * its record gone).
 */
describe('custom domains (e2e)', () => {
  let node: TestApp;
  const dns = fakeDns();
  let enabled = true;

  beforeAll(async () => {
    node = await bootApp(undefined, (builder) =>
      builder
        .overrideProvider(CUSTOM_DOMAINS_TXT_RESOLVER)
        .useValue(dns.resolver),
    );
    // CUSTOM_DOMAINS is off by default; on for this suite, off for one test.
    const config = node.app.get(ConfigService);
    const read = config.get.bind(config) as (...args: unknown[]) => unknown;
    vi.spyOn(config, 'get').mockImplementation(((key: string, ...rest: []) =>
      key === 'CUSTOM_DOMAINS' ? enabled : read(key, ...rest)) as never);
  });
  beforeEach(() => {
    enabled = true;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await node.close();
  });

  /** Adds `hostname` in the agent's tenant, publishes its record and runs the check as the worker does. */
  const verified = async (
    agent: request.Agent,
    tenantId: string,
    hostname: string,
  ) => {
    const created = await agent
      .post('/v1/branding/domains')
      .send({ hostname })
      .expect(201);
    dns.records.set(created.body.record.name, [[created.body.record.value]]);
    await agent
      .post(`/v1/branding/domains/${created.body.id}/verify`)
      .expect(202);
    await check(tenantId, created.body.id);
    return created.body as { id: string; record: { name: string } };
  };
  const check = (tenantId: string, domainId: string) =>
    node.app.get(BrandingDomainsProcessor).run({
      kind: 'domain-verification',
      domainId,
      tenantId,
    });
  const domainOf = async (agent: request.Agent, id: string) =>
    (await agent.get('/v1/branding/domains').expect(200)).body.domains.find(
      (domain: { id: string }) => domain.id === id,
    );
  const asked = (domain: string) =>
    node.http().get('/v1/internal/domains/allowed').query({ domain });

  describe('the hostname', () => {
    it.each([
      ['192.0.2.10', 'ip_address'],
      ['[2001:db8::1]', 'ip_address'],
      ['2001:db8::1', 'ip_address'],
      ['app.example.com:8443', 'port'],
      ['https://app.example.com', 'not_a_hostname'],
      ['app.example.com/path', 'not_a_hostname'],
      ['*.example.com', 'not_a_hostname'],
      ['user@app.example.com', 'not_a_hostname'],
      ['localhost', 'not_a_hostname'],
      ['printer.local', 'reserved'],
      ['app.internal', 'reserved'],
      ['app.test', 'reserved'],
      ['app.123', 'not_a_hostname'],
      ['-bad-.example.com', 'not_a_hostname'],
      [`${'a'.repeat(64)}.example.com`, 'not_a_hostname'],
      // The app's own (WEB_URL's host in the tests) and anything under it.
      ['web.example.com', 'app_domain'],
      ['tenant.web.example.com', 'app_domain'],
    ])('refuses %s (400)', async (hostname) => {
      const res = await node
        .admin()
        .post('/v1/branding/domains')
        .send({ hostname })
        .expect(400);
      expect(res.body).toMatchObject({ code: 'invalid_hostname' });
      expect(res.body.errors[0].path).toBe('hostname');
    });

    it('is stored lower case, without a trailing dot, an IDN in punycode, once per tenant', async () => {
      const tenant = await node.otherTenant();
      const upper = await tenant.admin
        .post('/v1/branding/domains')
        .send({ hostname: ' App.Acme-Corp.COM. ' })
        .expect(201);
      expect(upper.body).toMatchObject({
        hostname: 'app.acme-corp.com',
        verified: false,
        record: { type: 'TXT', name: '_app-verification.app.acme-corp.com' },
      });
      expect(upper.body.record.value).toMatch(/^app-verification=[\w-]{32}$/);
      const idn = await tenant.admin
        .post('/v1/branding/domains')
        .send({ hostname: 'bücher.example.de' })
        .expect(201);
      expect(idn.body.hostname).toBe('xn--bcher-kva.example.de');
      const again = await tenant.admin
        .post('/v1/branding/domains')
        .send({ hostname: 'APP.acme-corp.com' })
        .expect(409);
      expect(again.body.code).toBe('domain_exists');
      // Another tenant may list it too: only DNS decides who routes it.
      const other = await node.otherTenant();
      await other.admin
        .post('/v1/branding/domains')
        .send({ hostname: 'app.acme-corp.com' })
        .expect(201);
    });
  });

  it('needs Access.manageDomains; off (CUSTOM_DOMAINS) adding and verifying answer 404', async () => {
    const member = await node.user(['viewer']);
    await member.agent.get('/v1/branding/domains').expect(403);
    await member.agent
      .post('/v1/branding/domains')
      .send({ hostname: host() })
      .expect(403);
    const tenant = await node.otherTenant();
    const created = await tenant.admin
      .post('/v1/branding/domains')
      .send({ hostname: host() })
      .expect(201);
    enabled = false;
    expect(
      (await tenant.admin.get('/v1/branding/domains').expect(200)).body,
    ).toMatchObject({ enabled: false });
    const off = await tenant.admin
      .post('/v1/branding/domains')
      .send({ hostname: host() })
      .expect(404);
    expect(off.body.code).toBe('custom_domains_off');
    await tenant.admin
      .post(`/v1/branding/domains/${created.body.id}/verify`)
      .expect(404);
  });

  it('verifies through the TXT record and routes the host: the brand before sign-in, the TLS ask', async () => {
    const tenant = await node.otherTenant();
    await tenant.admin
      .put('/v1/branding')
      .send({ primaryColor: '#0a84ff', mailFromName: 'Acme' })
      .expect(200);
    const hostname = host();
    const created = await tenant.admin
      .post('/v1/branding/domains')
      .send({ hostname })
      .expect(201);
    // Not yet: the record isn't published.
    await check(tenant.id, created.body.id);
    expect(await domainOf(tenant.admin, created.body.id)).toMatchObject({
      verified: false,
      lastError: expect.stringContaining('ENOTFOUND'),
    });
    await asked(hostname).expect(404);
    // Remembered as unknown for 30 s (one database read for a flood);
    // verifying forgets it (the 200s below).
    const ttl = await node.app
      .get<Redis>(REDIS)
      .ttl(`custom-domains:unknown:${hostname}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
    expect(
      (
        await node
          .http()
          .get('/v1/branding/host')
          .set('Host', hostname)
          .expect(200)
      ).body,
    ).toEqual(GENERIC);
    // A record with another value is not the tenant's.
    dns.records.set(created.body.record.name, [['app-verification=other']]);
    await check(tenant.id, created.body.id);
    expect((await domainOf(tenant.admin, created.body.id)).verified).toBe(
      false,
    );

    dns.records.set(created.body.record.name, [[created.body.record.value]]);
    await check(tenant.id, created.body.id);
    expect(await domainOf(tenant.admin, created.body.id)).toMatchObject({
      verified: true,
      lastError: null,
    });
    expect(
      await node.auditEntries({
        action: 'branding.domain-verified',
        targetId: created.body.id,
      }),
    ).toHaveLength(1);
    await asked(hostname).expect(200);
    await asked(hostname.toUpperCase()).expect(200);
    // The brand of the host the request came to; the port is not part of it.
    const brand = await node
      .http()
      .get('/v1/branding/host')
      .set('Host', `${hostname}:443`)
      .expect(200);
    expect(brand.headers['cache-control']).toBe('no-store');
    expect(brand.body).toEqual({
      ...GENERIC,
      primaryColor: '#0a84ff',
      mailFromName: 'Acme',
    });
  });

  it('answers unknown hosts, the app’s own and IPs with the generic brand and no tenant', async () => {
    for (const unknown of [
      host(),
      'web.example.com',
      '127.0.0.1',
      'localhost',
    ]) {
      const res = await node
        .http()
        .get('/v1/branding/host')
        .set('Host', unknown)
        .expect(200);
      expect(res.body).toEqual(GENERIC);
      await asked(unknown).expect(404);
    }
    // The edge's question takes a hostname, nothing else.
    await node.http().get('/v1/internal/domains/allowed').expect(404);
    await asked('a'.repeat(400)).expect(404);
  });

  it('limits the edge’s question per address: 600 a minute, then 429', async () => {
    // An address of its own (trusted X-Forwarded-For, as the edge's
    // per-request check sends it), so the suite's other asks aren't counted.
    const address = `10.59.${randomInt(250)}.${randomInt(250)}`;
    const ask = () => asked(host()).set('X-Forwarded-For', address);
    for (let batch = 0; batch < 12; batch++) {
      const codes = await Promise.all(
        Array.from({ length: 50 }, async () => (await ask()).status),
      );
      expect(new Set(codes)).toEqual(new Set([404]));
    }
    const limited = await ask().expect(429);
    expect(limited.body).toMatchObject({ code: 'rate_limited' });
    // Another address is not limited.
    await asked(host())
      .set('X-Forwarded-For', `10.58.${randomInt(250)}.${randomInt(250)}`)
      .expect(404);
  });

  it('routes a hostname to the first tenant that proves it, not to another that lists it', async () => {
    const first = await node.otherTenant();
    const second = await node.otherTenant();
    const hostname = host();
    await verified(first.admin, first.id, hostname);
    const claim = await verified(second.admin, second.id, hostname);
    expect(await domainOf(second.admin, claim.id)).toMatchObject({
      verified: false,
      lastError: 'Another tenant uses this domain.',
    });
    expect(
      (await first.admin.get('/v1/auth/me').set('Host', hostname).expect(200))
        .body.user.tenantId,
    ).toBe(first.id);
    expect(
      (await second.admin.get('/v1/auth/me').set('Host', hostname).expect(200))
        .body.user.tenantId,
    ).toBeNull();
  });

  describe('on a verified host', () => {
    let tenant: Awaited<ReturnType<TestApp['otherTenant']>>;
    let hostname: string;
    let domainId: string;

    beforeEach(async () => {
      tenant = await node.otherTenant();
      hostname = host();
      domainId = (await verified(tenant.admin, tenant.id, hostname)).id;
    });

    it('a session acts in that tenant only: a member in it, anyone else in none', async () => {
      // The tenant's administrator, there.
      const own = await tenant.admin
        .get('/v1/auth/me')
        .set('Host', hostname)
        .expect(200);
      expect(own.body.user.tenantId).toBe(tenant.id);
      // The seeded administrator is no member of it: no tenant there, so
      // nothing of their own tenant either.
      const stranger = await node
        .admin()
        .get('/v1/auth/me')
        .set('Host', hostname)
        .expect(200);
      expect(stranger.body.user.tenantId).toBeNull();
      await node
        .admin()
        .get('/v1/access/roles')
        .set('Host', hostname)
        .expect(403);
      expect(
        (
          await node
            .admin()
            .get('/v1/branding')
            .set('Host', hostname)
            .expect(200)
        ).body,
      ).toMatchObject({ ...GENERIC, canEdit: false });
      // On the app's own host, as before.
      expect(
        (await node.admin().get('/v1/auth/me').expect(200)).body.user.tenantId,
      ).toBe(node.tenantId);
    });

    it('takes same-origin writes and refuses its origin on the app’s host; the cookie stays host-only', async () => {
      const origin = `https://${hostname}`;
      // Same origin on the custom host: the CSRF check lets it through.
      const signIn = await node
        .http()
        .post('/v1/auth/sign-in')
        .set('Host', hostname)
        .set('Origin', origin)
        .send({ email: tenant.email, password: tenant.password })
        .expect(200);
      const cookies = ([] as string[]).concat(
        signIn.headers['set-cookie'] ?? [],
      );
      expect(cookies.length).toBeGreaterThan(0);
      for (const cookie of cookies) {
        expect(cookie).not.toMatch(/;\s*domain=/i);
      }
      // The custom domain is never a trusted origin of the app's own host.
      await tenant.admin
        .put('/v1/branding')
        .set('Origin', origin)
        .send({ primaryColor: '#123456' })
        .expect(403);
      // Nor of another tenant's custom host.
      const other = await node.otherTenant();
      const otherHost = host();
      await verified(other.admin, other.id, otherHost);
      await other.admin
        .put('/v1/branding')
        .set('Host', otherHost)
        .set('Origin', origin)
        .send({ primaryColor: '#123456' })
        .expect(403);
      await tenant.admin
        .put('/v1/branding')
        .set('Host', hostname)
        .set('Origin', origin)
        .send({ primaryColor: '#123456' })
        .expect(200);
    });

    it('keeps SSO on APP_URL: the SAML service provider’s URLs never follow the Host', async () => {
      const idp = await samlIdp();
      const created = await tenant.admin
        .post('/v1/sso/connections')
        .set('Host', hostname)
        .send({
          protocol: 'saml',
          name: `saml-${randomUUID().slice(0, 8)}`,
          idpEntityId: idp.entityId,
          idpSsoUrl: 'https://idp.acme.test/sso',
          idpCertificates: [idp.cert],
          enabled: true,
        })
        .expect(201);
      const appUrl = process.env.APP_URL!;
      for (const url of [
        created.body.loginUrl,
        created.body.saml.acsUrl,
        created.body.saml.metadataUrl,
      ]) {
        expect(url.startsWith(`${appUrl}/`)).toBe(true);
        expect(url).not.toContain(hostname);
      }
      const login = await node
        .http()
        .get(local(created.body.loginUrl))
        .set('Host', hostname)
        .expect(302);
      const xml = inflateRawSync(
        Buffer.from(
          new URL(login.headers.location).searchParams.get('SAMLRequest')!,
          'base64',
        ),
      ).toString();
      expect(xml).toContain(
        `AssertionConsumerServiceURL="${created.body.saml.acsUrl}"`,
      );
      expect(xml).not.toContain(hostname);
    });

    it('removed, stops at once: no ask, no brand, no session pinned to it', async () => {
      await tenant.admin.delete(`/v1/branding/domains/${domainId}`).expect(204);
      await asked(hostname).expect(404);
      expect(
        (
          await node
            .http()
            .get('/v1/branding/host')
            .set('Host', hostname)
            .expect(200)
        ).body,
      ).toEqual(GENERIC);
      // The seeded administrator is back in their own tenant on that host.
      expect(
        (
          await node
            .admin()
            .get('/v1/auth/me')
            .set('Host', hostname)
            .expect(200)
        ).body.user.tenantId,
      ).toBe(node.tenantId);
      expect(
        await node.auditEntries({
          action: 'branding.domain-removed',
          targetId: domainId,
        }),
      ).toHaveLength(1);
    });

    it('its record gone, the nightly check suspends it; a failed lookup changes nothing', async () => {
      const name = `_app-verification.${hostname}`;
      const value = dns.records.get(name)!;
      // A DNS outage: still verified, the error recorded.
      dns.records.delete(name);
      const resolver = dns.resolver.resolveTxt;
      dns.resolver.resolveTxt = () =>
        Promise.reject(
          Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }),
        );
      try {
        await node.app.get(BrandingDomainsJob).run();
      } finally {
        dns.resolver.resolveTxt = resolver;
      }
      expect(await domainOf(tenant.admin, domainId)).toMatchObject({
        verified: true,
        lastError: expect.stringContaining('ETIMEOUT'),
      });
      await asked(hostname).expect(200);
      // The record gone (the domain changed hands): suspended, unrouted.
      await node.app.get(BrandingDomainsJob).run();
      expect(await domainOf(tenant.admin, domainId)).toMatchObject({
        verified: false,
        verifiedAt: null,
      });
      await asked(hostname).expect(404);
      expect(
        await node.auditEntries({
          action: 'branding.domain-suspended',
          targetId: domainId,
        }),
      ).toHaveLength(1);
      // Published again, a check routes it again.
      dns.records.set(name, value);
      await check(tenant.id, domainId);
      await asked(hostname).expect(200);
    });

    it('the operators’ lock refuses adding and verifying, never removing', async () => {
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
        const add = await tenant.admin
          .post('/v1/branding/domains')
          .send({ hostname: host() })
          .expect(409);
        expect(add.body.code).toBe('branding_locked');
        await tenant.admin
          .post(`/v1/branding/domains/${domainId}/verify`)
          .expect(409);
        await tenant.admin
          .delete(`/v1/branding/domains/${domainId}`)
          .expect(204);
      } finally {
        await node
          .admin()
          .delete('/v1/settings/branding.locked/platform')
          .expect(204);
      }
    });

    it('a deactivated tenant’s host routes nowhere', async () => {
      await node
        .admin()
        .patch(`/v1/tenants/${tenant.id}`)
        .send({ active: false })
        .expect(200);
      await asked(hostname).expect(404);
      expect(
        (
          await node
            .http()
            .get('/v1/branding/host')
            .set('Host', hostname)
            .expect(200)
        ).body,
      ).toEqual(GENERIC);
    });
  });
});
