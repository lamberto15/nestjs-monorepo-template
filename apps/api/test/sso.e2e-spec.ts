import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { SsoProcessor } from '../src/iam/sso/sso.processor.js';
import { SSO_TXT_RESOLVER } from '../src/iam/sso/sso.queue.js';
import { ssoConnections } from '../src/iam/sso/sso.tables.js';
import {
  authnRequestId,
  fakeDns,
  local,
  larkUser,
  oauth2Idp,
  oidcIdp,
  samlIdp,
  samlResponse,
  type SamlIdp,
  verifyDomain,
} from './sso-support.js';
import { bootApp, type TestApp } from './support.js';

// Read when AppModule loads: the fake OpenID Connect provider is plain
// HTTP on loopback.
vi.hoisted(() => {
  process.env.SSO_ALLOW_LOOPBACK = 'on';
});

const DOMAIN = 'acme.test';

/** A client secret made for the run (never a literal). */
const newSecret = () => randomBytes(24).toString('base64url');

/**
 * Enterprise SSO (docs/auth.md, "Enterprise SSO"): a tenant's SAML and
 * OpenID Connect connections, against IdPs made by the test (keys and
 * certificates generated at run time).
 */
describe('enterprise SSO (e2e)', () => {
  let node: TestApp;
  const dns = fakeDns();

  beforeAll(async () => {
    node = await bootApp(undefined, (builder) =>
      builder.overrideProvider(SSO_TXT_RESOLVER).useValue(dns.resolver),
    );
    await verifyDomain(node, dns, node.admin(), node.tenantId, DOMAIN);
  });
  afterAll(() => node.close());

  /** The reasons SSO sign-ins were refused (audited), newest first. */
  const refusals = async () =>
    (await node.auditEntries({ action: 'auth.sign-in-failed' }))
      .map((entry) => (entry.details as { reason?: string } | null)?.reason)
      .filter(Boolean) as string[];

  const expectFailed = (location: string) =>
    expect(new URL(location).searchParams.get('error')).toBe('sso_failed');

  describe('connections', () => {
    it('are off by default, need Access.manageSso, and keep the client secret encrypted', async () => {
      const member = await node.user(['viewer']);
      await member.agent.get('/v1/sso/connections').expect(403);
      const secret = newSecret();
      const created = await node
        .admin()
        .post('/v1/sso/connections')
        .send({
          protocol: 'oidc',
          name: `oidc-${randomUUID().slice(0, 8)}`,
          issuer: 'https://login.acme.test',
          clientId: 'app',
          clientSecret: secret,
        })
        .expect(201);
      expect(created.body.enabled).toBe(false);
      expect(JSON.stringify(created.body)).not.toContain(secret);
      // Off: its sign-in URL is a 404, as an unknown connection's.
      await node.http().get(local(created.body.loginUrl)).expect(404);
      // Stored encrypted (core/encryption): never the plain value.
      const [row] = await node.db
        .select({ stored: ssoConnections.clientSecret })
        .from(ssoConnections)
        .where(eq(ssoConnections.id, created.body.id));
      expect(String(row.stored)).not.toContain(secret);
    });

    it('verify a domain through its TXT record', async () => {
      await node
        .admin()
        .post('/v1/sso/domains')
        .send({ domain: 'unverified.test' })
        .expect(201);
      const domains = await node.admin().get('/v1/sso/domains').expect(200);
      const byName = (name: string) =>
        domains.body.items.find(
          (domain: { domain: string }) => domain.domain === name,
        );
      expect(byName('unverified.test').verified).toBe(false);
      expect(byName(DOMAIN).verified).toBe(true);
    });
  });

  describe('SAML', () => {
    let idp: SamlIdp;
    let connection: {
      id: string;
      loginUrl: string;
      saml: { spEntityId: string; acsUrl: string; metadataUrl: string };
    };

    beforeAll(async () => {
      idp = await samlIdp();
      const created = await node
        .admin()
        .post('/v1/sso/connections')
        .send({
          protocol: 'saml',
          name: `saml-${randomUUID().slice(0, 8)}`,
          idpEntityId: idp.entityId,
          idpSsoUrl: 'https://idp.acme.test/sso',
          idpCertificates: [idp.cert],
          jitProvisioning: true,
          enabled: true,
        })
        .expect(201);
      connection = created.body;
    });

    /** A browser that started a sign-in: its agent (the binding cookie) and the AuthnRequest's ID. */
    const start = async () => {
      const browser = request.agent(node.app.getHttpServer());
      const login = await browser.get(local(connection.loginUrl)).expect(302);
      expect(login.headers.location).toMatch(
        /^https:\/\/idp\.acme\.test\/sso\?SAMLRequest=/,
      );
      return { browser, requestId: authnRequestId(login.headers.location) };
    };

    /** The IdP's POST, cross-site as a browser sends it, then the hand-over. */
    const post = async (browser: request.Agent, response: string) => {
      const acs = await browser
        .post(local(connection.saml.acsUrl))
        .set('Origin', 'https://idp.acme.test')
        .set('Sec-Fetch-Site', 'cross-site')
        .type('form')
        .send({ SAMLResponse: response })
        .expect(303);
      const location = acs.headers.location as string;
      if (!location.includes('/saml/complete')) {
        return location;
      }
      const complete = await browser.get(local(location)).expect(302);
      return complete.headers.location as string;
    };

    const valid = (
      requestId: string | undefined,
      overrides: Partial<Parameters<typeof samlResponse>[1]> = {},
    ) => ({
      audience: connection.saml.spEntityId,
      acs: connection.saml.acsUrl,
      nameId: `employee-${randomUUID()}`,
      email: `${randomUUID().slice(0, 8)}@${DOMAIN}`,
      inResponseTo: requestId,
      ...overrides,
    });

    it('serves its SP metadata', async () => {
      const metadata = await node
        .http()
        .get(local(connection.saml.metadataUrl))
        .expect(200);
      expect(metadata.headers['content-type']).toContain(
        'application/samlmetadata+xml',
      );
      expect(metadata.text).toContain(connection.saml.acsUrl);
      expect(metadata.text).toContain('WantAssertionsSigned="true"');
    });

    it('signs a person in from a validly signed assertion (just in time)', async () => {
      const { browser, requestId } = await start();
      const assertion = valid(requestId);
      const landed = await post(browser, samlResponse(idp, assertion));
      expect(new URL(landed).origin).toBe('https://web.example.com');
      expect(new URL(landed).searchParams.get('error')).toBeNull();
      const me = await browser.get('/v1/auth/me').expect(200);
      expect(me.body.user.email).toBe(assertion.email);
      expect(me.body.user.tenantId).toBe(node.tenantId);
      // The session says how it was signed in (docs/auth.md, step-up).
      const sessions = await browser.get('/v1/auth/sessions').expect(200);
      expect(sessions.body.items).toMatchObject([
        { current: true, method: 'sso', provider: connection.id },
      ]);
      // The same identity again: the same account, linked by its subject.
      const again = await start();
      await post(
        again.browser,
        samlResponse(
          idp,
          valid(again.requestId, {
            nameId: assertion.nameId,
            email: assertion.email,
          }),
        ),
      );
      const meAgain = await again.browser.get('/v1/auth/me').expect(200);
      expect(meAgain.body.user.id).toBe(me.body.user.id);
    });

    it('refuses an assertion whose signature does not verify', async () => {
      const { browser, requestId } = await start();
      const assertion = valid(requestId);
      // Signed, then changed: the digest no longer matches.
      expectFailed(
        await post(
          browser,
          samlResponse(idp, {
            ...assertion,
            tamper: (xml) => xml.replace(assertion.email, `ceo@${DOMAIN}`),
          }),
        ),
      );
      await browser.get('/v1/auth/me').expect(401);
      expect((await refusals())[0]).toMatch(/^response_invalid:/);
      // Signed by another key than the connection's certificate.
      const other = await samlIdp();
      const second = await start();
      expectFailed(
        await post(
          second.browser,
          samlResponse(idp, { ...valid(second.requestId), signWith: other }),
        ),
      );
      await second.browser.get('/v1/auth/me').expect(401);
      expect((await refusals())[0]).toMatch(/^response_invalid:/);
    });

    it('refuses a replayed assertion', async () => {
      const { browser, requestId } = await start();
      const response = samlResponse(idp, valid(requestId));
      await post(browser, response);
      await browser.get('/v1/auth/me').expect(200);
      // The same response again, from another browser and from the same:
      // its request was answered (InResponseTo), and its assertion seen.
      const attacker = request.agent(node.app.getHttpServer());
      expectFailed(await post(attacker, response));
      expectFailed(await post(browser, response));
      await attacker.get('/v1/auth/me').expect(401);

      // IdP-initiated (no request to tie it to): the assertion's ID alone
      // stops a second use.
      const unsolicited = await node
        .admin()
        .post('/v1/sso/connections')
        .send({
          protocol: 'saml',
          name: `idp-initiated-${randomUUID().slice(0, 8)}`,
          idpEntityId: idp.entityId,
          idpSsoUrl: 'https://idp.acme.test/sso',
          idpCertificates: [idp.cert],
          allowIdpInitiated: true,
          jitProvisioning: true,
          enabled: true,
        })
        .expect(201);
      const acs = unsolicited.body.saml.acsUrl as string;
      const pushed = samlResponse(idp, {
        audience: unsolicited.body.saml.spEntityId,
        acs,
        nameId: `employee-${randomUUID()}`,
        email: `${randomUUID().slice(0, 8)}@${DOMAIN}`,
      });
      const send = async (agent: request.Agent) => {
        const posted = await agent
          .post(local(acs))
          .type('form')
          .send({ SAMLResponse: pushed })
          .expect(303);
        const location = posted.headers.location as string;
        return location.includes('/saml/complete')
          ? ((await agent.get(local(location)).expect(302)).headers
              .location as string)
          : location;
      };
      const first = request.agent(node.app.getHttpServer());
      expect(new URL(await send(first)).searchParams.get('error')).toBeNull();
      await first.get('/v1/auth/me').expect(200);
      const replayer = request.agent(node.app.getHttpServer());
      expectFailed(await send(replayer));
      expect((await refusals())[0]).toBe('assertion_replayed');
      await replayer.get('/v1/auth/me').expect(401);
    });

    it('refuses another audience, an expired assertion, another issuer', async () => {
      const cases: [Partial<Parameters<typeof samlResponse>[1]>, RegExp][] = [
        [{ audience: 'https://other-sp.test/metadata' }, /^response_invalid:/],
        [{ notOnOrAfter: Date.now() - 10 * 60_000 }, /^response_invalid:/],
        [{ issuer: 'https://evil.test/saml' }, /^issuer_mismatch$/],
      ];
      for (const [overrides, reason] of cases) {
        const { browser, requestId } = await start();
        expectFailed(
          await post(browser, samlResponse(idp, valid(requestId, overrides))),
        );
        await browser.get('/v1/auth/me').expect(401);
        expect((await refusals())[0]).toMatch(reason);
      }
    });

    it('refuses a response for another browser, and an unsolicited one', async () => {
      const { browser, requestId } = await start();
      const stranger = request.agent(node.app.getHttpServer());
      // Login CSRF: the attacker's assertion pushed into another browser.
      expectFailed(await post(stranger, samlResponse(idp, valid(requestId))));
      await stranger.get('/v1/auth/me').expect(401);
      // No request of ours at all (IdP-initiated is off by default).
      expectFailed(await post(browser, samlResponse(idp, valid(undefined))));
      await browser.get('/v1/auth/me').expect(401);
    });

    it('refuses an address of an unverified domain', async () => {
      const { browser, requestId } = await start();
      expectFailed(
        await post(
          browser,
          samlResponse(idp, valid(requestId, { email: 'x@unverified.test' })),
        ),
      );
      await browser.get('/v1/auth/me').expect(401);
    });

    it('keeps tenants apart: another tenant’s id is a 404, another SP’s assertion is refused', async () => {
      const other = await node.otherTenant();
      await node
        .http()
        .get(local(connection.loginUrl.replace(node.tenantId, other.id)))
        .expect(404);
      // The other tenant trusts the same IdP: an assertion for this
      // tenant's SP (its audience) is refused at the other's ACS.
      const otherConnection = await other.admin
        .post('/v1/sso/connections')
        .send({
          protocol: 'saml',
          name: 'same-idp',
          idpEntityId: idp.entityId,
          idpSsoUrl: 'https://idp.acme.test/sso',
          idpCertificates: [idp.cert],
          jitProvisioning: true,
          enabled: true,
        })
        .expect(201);
      const browser = request.agent(node.app.getHttpServer());
      const login = await browser
        .get(local(otherConnection.body.loginUrl))
        .expect(302);
      const acs = await browser
        .post(local(otherConnection.body.saml.acsUrl))
        .type('form')
        .send({
          SAMLResponse: samlResponse(idp, {
            audience: connection.saml.spEntityId,
            acs: otherConnection.body.saml.acsUrl,
            nameId: 'someone',
            email: `someone@${DOMAIN}`,
            inResponseTo: authnRequestId(login.headers.location),
          }),
        })
        .expect(303);
      expectFailed(acs.headers.location);
      await browser.get('/v1/auth/me').expect(401);
    });

    it('imports an IdP from its metadata URL (Access.manageSso, https, nothing stored)', async () => {
      const idpCert = idp.cert.replace(/-----[A-Z ]+-----|\s+/g, '');
      const xml =
        `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${idp.entityId}">` +
        `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
        `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${idpCert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
        `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.acme.test/sso"/>` +
        `</md:IDPSSODescriptor></md:EntityDescriptor>`;
      const server = createServer((_request, response) => response.end(xml));
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/metadata`;
        const member = await node.user(['viewer']);
        await member.agent
          .post('/v1/sso/saml/metadata')
          .send({ url })
          .expect(403);
        const before = await node
          .admin()
          .get('/v1/sso/connections')
          .expect(200);
        const imported = await node
          .admin()
          .post('/v1/sso/saml/metadata')
          .send({ url })
          .expect(200);
        expect(imported.body).toMatchObject({
          idpEntityId: idp.entityId,
          idpSsoUrl: 'https://idp.acme.test/sso',
        });
        // What it answers creates a connection as it is.
        const created = await node
          .admin()
          .post('/v1/sso/connections')
          .send({
            protocol: 'saml',
            name: `imported-${randomUUID().slice(0, 8)}`,
            ...imported.body,
          })
          .expect(201);
        expect(created.body.saml.idpEntityId).toBe(idp.entityId);
        const after = await node.admin().get('/v1/sso/connections').expect(200);
        expect(after.body.items).toHaveLength(before.body.items.length + 1);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
      // Refused destinations answer 422, never what they hold.
      for (const refused of [
        'https://169.254.169.254/latest/meta-data',
        'https://10.0.0.1/metadata',
      ]) {
        const answer = await node
          .admin()
          .post('/v1/sso/saml/metadata')
          .send({ url: refused })
          .expect(422);
        // Loopback is allowed in this suite; link-local never is.
        if (refused.includes('169.254')) {
          expect(answer.body.code).toBe('saml_metadata_url_refused');
        }
      }
      await node
        .admin()
        .post('/v1/sso/saml/metadata')
        .send({ url: 'not a url' })
        .expect(400);
    });
  });

  describe('OpenID Connect', () => {
    let idp: Awaited<ReturnType<typeof oidcIdp>>;
    let connection: { id: string; loginUrl: string };

    beforeAll(async () => {
      idp = await oidcIdp('acme-app');
      const created = await node
        .admin()
        .post('/v1/sso/connections')
        .send({
          protocol: 'oidc',
          name: `oidc-${randomUUID().slice(0, 8)}`,
          issuer: idp.issuer,
          clientId: 'acme-app',
          clientSecret: newSecret(),
          jitProvisioning: true,
          enabled: true,
        })
        .expect(201);
      connection = created.body;
      // The worker's job: the discovery document, through the guarded fetch.
      await node.app.get(SsoProcessor).run({
        kind: 'oidc-discovery',
        connectionId: connection.id,
        tenantId: node.tenantId,
      });
      const fetched = await node
        .admin()
        .get(`/v1/sso/connections/${connection.id}`)
        .expect(200);
      expect(fetched.body.oidc.metadataError).toBeNull();
      expect(fetched.body.oidc.metadataFetchedAt).not.toBeNull();
    });
    afterAll(() => idp.close());

    const start = async () => {
      const browser = request.agent(node.app.getHttpServer());
      const login = await browser.get(local(connection.loginUrl)).expect(302);
      expect(login.headers.location).toContain(`${idp.issuer}/authorize?`);
      expect(login.headers.location).toContain('code_challenge_method=S256');
      return { browser, location: login.headers.location as string };
    };

    const callback = (browser: request.Agent, params: Record<string, string>) =>
      browser
        .get(
          `/v1/auth/sso/${node.tenantId}/${connection.id}/oidc/callback?${new URLSearchParams(params)}`,
        )
        .expect(302);

    it('signs a person in with a verified address (PKCE, state, nonce)', async () => {
      const { browser, location } = await start();
      const email = `${randomUUID().slice(0, 8)}@${DOMAIN}`;
      const landed = await callback(
        browser,
        idp.issue(location, { sub: randomUUID(), email, email_verified: true }),
      );
      expect(
        new URL(landed.headers.location).searchParams.get('error'),
      ).toBeNull();
      const me = await browser.get('/v1/auth/me').expect(200);
      expect(me.body.user.email).toBe(email);
      expect(idp.tokenRequests.at(-1)!.get('code_verifier')).toBeTruthy();
    });

    it('refuses a wrong nonce, another browser, an address not verified by the IdP', async () => {
      const first = await start();
      expectFailed(
        (
          await callback(
            first.browser,
            idp.issue(first.location, {
              sub: randomUUID(),
              email: `a@${DOMAIN}`,
              email_verified: true,
              nonce: 'another-nonce',
            }),
          )
        ).headers.location,
      );
      expect((await refusals())[0]).toMatch(/^token_rejected:/);

      const second = await start();
      const stranger = request.agent(node.app.getHttpServer());
      expectFailed(
        (
          await callback(
            stranger,
            idp.issue(second.location, {
              sub: randomUUID(),
              email: `b@${DOMAIN}`,
              email_verified: true,
            }),
          )
        ).headers.location,
      );
      expect((await refusals())[0]).toBe('state_mismatch');

      const third = await start();
      expectFailed(
        (
          await callback(
            third.browser,
            idp.issue(third.location, {
              sub: randomUUID(),
              email: `c@${DOMAIN}`,
              // A string is no verified claim.
              email_verified: 'true',
            }),
          )
        ).headers.location,
      );
      await third.browser.get('/v1/auth/me').expect(401);
    });

    it('takes a callback once', async () => {
      const { browser, location } = await start();
      const params = idp.issue(location, {
        sub: randomUUID(),
        email: `${randomUUID().slice(0, 8)}@${DOMAIN}`,
        email_verified: true,
      });
      await callback(browser, params);
      await browser.get('/v1/auth/me').expect(200);
      // The callback clears the binding cookie: a replay has no binding.
      expectFailed((await callback(browser, params)).headers.location);
    });
  });

  describe('OAuth 2.0 (a Lark-shaped provider)', () => {
    let idp: Awaited<ReturnType<typeof oauth2Idp>>;
    const secret = newSecret();
    let connection: {
      id: string;
      loginUrl: string;
      oauth2: { redirectUri: string };
    };

    beforeAll(async () => {
      idp = await oauth2Idp();
      // The Lark preset (mapping, client_secret_post), its endpoints here.
      const created = await node
        .admin()
        .post('/v1/sso/connections')
        .send({
          protocol: 'oauth2',
          name: `lark-${randomUUID().slice(0, 8)}`,
          preset: { name: 'lark', region: 'feishu' },
          ...idp.endpoints,
          clientId: 'cli_lark',
          clientSecret: secret,
          jitProvisioning: true,
          enabled: true,
        })
        .expect(201);
      connection = created.body;
    });
    afterAll(() => idp.close());

    const start = async () => {
      const browser = request.agent(node.app.getHttpServer());
      const login = await browser.get(local(connection.loginUrl)).expect(302);
      return { browser, location: login.headers.location as string };
    };

    const callback = (browser: request.Agent, params: Record<string, string>) =>
      browser
        .get(
          `/v1/auth/sso/${node.tenantId}/${connection.id}/oauth2/callback?${new URLSearchParams(params)}`,
        )
        .expect(302);

    /** A sign-in through the provider whose user info answers `answer`: where it landed, and the browser. */
    const signIn = async (answer: Parameters<typeof idp.issue>[1]) => {
      const { browser, location } = await start();
      const landed = await callback(browser, idp.issue(location, answer));
      return { browser, location: landed.headers.location as string };
    };

    it('shows its endpoints and mapping, never the secret; has no discovery', async () => {
      const shown = await node
        .admin()
        .get(`/v1/sso/connections/${connection.id}`)
        .expect(200);
      expect(shown.body).toMatchObject({
        protocol: 'oauth2',
        oidc: null,
        saml: null,
        oauth2: {
          ...idp.endpoints,
          clientId: 'cli_lark',
          tokenEndpointAuthMethod: 'client_secret_post',
          scopes: [],
          preset: { name: 'lark', region: 'feishu' },
          mapping: {
            root: 'data',
            subject: 'open_id',
            email: 'enterprise_email',
            emailVerified: 'verified-domains',
            errorCode: 'code',
          },
        },
      });
      expect(shown.body.oauth2.redirectUri).toMatch(/\/oauth2\/callback$/);
      expect(JSON.stringify(shown.body)).not.toContain(secret);
      const list = await node.admin().get('/v1/sso/connections').expect(200);
      expect(JSON.stringify(list.body)).not.toContain(secret);
      const refresh = await node
        .admin()
        .post(`/v1/sso/connections/${connection.id}/refresh`)
        .expect(409);
      expect(refresh.body.code).toBe('sso_no_discovery');
    });

    it('validates per protocol', async () => {
      const admin = node.admin();
      // Neither a preset nor the endpoints and mapping.
      const missing = await admin
        .post('/v1/sso/connections')
        .send({
          protocol: 'oauth2',
          name: `bare-${randomUUID().slice(0, 8)}`,
          clientId: 'x',
          clientSecret: newSecret(),
        })
        .expect(400);
      expect(
        missing.body.errors.map((error: { path: string }) => error.path),
      ).toEqual(
        expect.arrayContaining([
          'authorizationEndpoint',
          'tokenEndpoint',
          'userinfoEndpoint',
          'mapping',
        ]),
      );
      // A confidential client needs its secret.
      await admin
        .post('/v1/sso/connections')
        .send({
          protocol: 'oauth2',
          name: `nosecret-${randomUUID().slice(0, 8)}`,
          preset: { name: 'lark' },
          clientId: 'x',
        })
        .expect(400);
      // A public one doesn't.
      await admin
        .post('/v1/sso/connections')
        .send({
          protocol: 'oauth2',
          name: `public-${randomUUID().slice(0, 8)}`,
          preset: { name: 'lark' },
          tokenEndpointAuthMethod: 'none',
          clientId: 'x',
        })
        .expect(201);
      // An OIDC field, a groups attribute (its groups are `mapping.groups`).
      for (const change of [
        { issuer: 'https://login.acme.test' },
        { groupsAttribute: 'groups' },
        { idpSsoUrl: 'https://idp.acme.test/sso' },
      ]) {
        await admin
          .patch(`/v1/sso/connections/${connection.id}`)
          .send(change)
          .expect(400);
      }
      // A mapping is no OIDC field.
      const oidc = await admin
        .post('/v1/sso/connections')
        .send({
          protocol: 'oidc',
          name: `oidc-${randomUUID().slice(0, 8)}`,
          issuer: 'https://login.acme.test',
          clientId: 'app',
          clientSecret: newSecret(),
        })
        .expect(201);
      await admin
        .patch(`/v1/sso/connections/${oidc.body.id}`)
        .send({ mapping: { subject: 'id' } })
        .expect(400);
      // Its OIDC callback isn't this connection's.
      await node
        .http()
        .get(
          `/v1/auth/sso/${node.tenantId}/${connection.id}/oidc/callback?code=x&state=y`,
        )
        .expect(404);
    });

    it('signs a person in and provisions them just in time (PKCE, state, no nonce)', async () => {
      const { browser, location } = await start();
      const authorize = new URL(location);
      expect(`${authorize.origin}${authorize.pathname}`).toBe(
        idp.endpoints.authorizationEndpoint,
      );
      expect(authorize.searchParams.get('client_id')).toBe('cli_lark');
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
      expect(authorize.searchParams.get('redirect_uri')).toBe(
        connection.oauth2.redirectUri,
      );
      expect(authorize.searchParams.has('nonce')).toBe(false);
      expect(authorize.searchParams.has('scope')).toBe(false);
      const email = `${randomUUID().slice(0, 8)}@${DOMAIN}`;
      const openId = `ou_${randomUUID().slice(0, 12)}`;
      const landed = await callback(
        browser,
        idp.issue(
          location,
          larkUser({
            open_id: openId,
            enterprise_email: email,
            email: 'personal@gmail.test',
          }),
        ),
      );
      expect(
        new URL(landed.headers.location).searchParams.get('error'),
      ).toBeNull();
      const me = await browser.get('/v1/auth/me').expect(200);
      expect(me.body.user.email).toBe(email);
      expect(me.body.user.tenantId).toBe(node.tenantId);
      // client_secret_post, the PKCE verifier; the token as bearer for user info.
      const token = idp.tokenRequests.at(-1)!;
      expect(token.form.get('client_id')).toBe('cli_lark');
      expect(token.form.get('client_secret')).toBe(secret);
      expect(token.form.get('code_verifier')).toBeTruthy();
      expect(token.authorization).toBeUndefined();
      expect(idp.userinfoRequests.at(-1)!.authorization).toMatch(/^Bearer /);
      // No auth_time: the sign-in counts from now (step-up).
      const sessions = await browser.get('/v1/auth/sessions').expect(200);
      const current = sessions.body.items.find(
        (session: { current: boolean }) => session.current,
      );
      expect(current).toMatchObject({ method: 'sso', provider: connection.id });
      expect(
        Math.abs(Date.parse(current.authenticatedAt) - Date.now()),
      ).toBeLessThan(60_000);
      // The same open_id again, whatever the address now: the same account.
      const again = await signIn(
        larkUser({ open_id: openId, enterprise_email: `x-${email}` }),
      );
      const meAgain = await again.browser.get('/v1/auth/me').expect(200);
      expect(meAgain.body.user.id).toBe(me.body.user.id);
    });

    it('links an existing, verified account of a verified domain', async () => {
      const email = `${randomUUID().slice(0, 8)}@${DOMAIN}`;
      const password = await node.acceptAsNew(
        await node.invite(node.admin(), { email, name: email }),
      );
      const existing = await node.signIn(email, password);
      const id = (await existing.get('/v1/auth/me').expect(200)).body.user.id;
      const { browser } = await signIn(
        larkUser({ open_id: `ou_${randomUUID()}`, enterprise_email: email }),
      );
      expect((await browser.get('/v1/auth/me').expect(200)).body.user.id).toBe(
        id,
      );
    });

    it('refuses, auditing why: a failed answer, no subject, malformed JSON, an error status, too large, a bad code, no address', async () => {
      const cases: [Parameters<typeof idp.issue>[1], string][] = [
        [
          larkUser(
            { open_id: 'ou_x', enterprise_email: `a@${DOMAIN}` },
            99991663,
          ),
          'userinfo_error:99991663',
        ],
        [larkUser({ enterprise_email: `b@${DOMAIN}` }), 'no_stable_subject'],
        [{ raw: '{"code":0,"data":' }, 'userinfo_malformed'],
        [{ status: 500, body: { code: 0 } }, 'userinfo_failed:500'],
        // Past 512 KiB, the rest is never read.
        [{ raw: `"${'x'.repeat(600 * 1024)}"` }, 'userinfo_failed:too_large'],
        [
          larkUser({ open_id: `ou_${randomUUID()}`, email: `c@${DOMAIN}` }),
          'no_email',
        ],
      ];
      for (const [answer, reason] of cases) {
        const { browser, location } = await signIn(answer);
        expectFailed(location);
        expect(location).not.toContain(reason);
        expect((await refusals())[0]).toBe(reason);
        await browser.get('/v1/auth/me').expect(401);
      }
      // A code the provider doesn't know.
      const { browser, location } = await start();
      const landed = await callback(browser, {
        code: 'unknown',
        state: new URL(location).searchParams.get('state')!,
      });
      expectFailed(landed.headers.location);
      expect((await refusals())[0]).toMatch(/^token_rejected:/);
    });
  });
});
