import { randomUUID, verify } from 'node:crypto';
import request from 'supertest';
import { SSO_TXT_RESOLVER } from '../src/iam/sso/sso.queue.js';
import {
  authnRequestId,
  encryptedSamlResponse,
  fakeDns,
  local,
  samlIdp,
  samlResponse,
  type SamlIdp,
  type SamlResponseOptions,
  verifyDomain,
} from './sso-support.js';
import { bootApp, type TestApp, totp } from './support.js';

const DOMAIN = 'acme.test';

interface Connection {
  id: string;
  loginUrl: string;
  roleMappings: { group: string; roleId: string }[];
  defaultRoleIds: string[];
  saml: {
    spEntityId: string;
    acsUrl: string;
    metadataUrl: string;
    spCertificate: { pem: string };
  };
}

/**
 * Enterprise SSO, part 2 (docs/auth.md, "Enterprise SSO"): strict SAML
 * (signed responses and assertions, allowed algorithms, signed requests,
 * encrypted assertions), roles from the IdP's groups, "SSO required" with
 * its break-glass exemptions, and finding the connection by address.
 */
describe('enterprise SSO: strict SAML, roles, SSO required (e2e)', () => {
  let node: TestApp;
  const dns = fakeDns();
  let idp: SamlIdp;

  beforeAll(async () => {
    node = await bootApp(undefined, (builder) =>
      builder.overrideProvider(SSO_TXT_RESOLVER).useValue(dns.resolver),
    );
    await verifyDomain(node, dns, node.admin(), node.tenantId, DOMAIN);
    idp = await samlIdp();
  });
  afterAll(() => node.close());

  /** The reasons SSO sign-ins were refused (audited), newest first. */
  const refusals = async () =>
    (await node.auditEntries({ action: 'auth.sign-in-failed' }))
      .map((entry) => (entry.details as { reason?: string } | null)?.reason)
      .filter(Boolean) as string[];

  /** A SAML connection made by `agent`, on. */
  const connect = async (
    agent: request.Agent,
    body: Record<string, unknown> = {},
  ) =>
    (
      await agent
        .post('/v1/sso/connections')
        .send({
          protocol: 'saml',
          name: `saml-${randomUUID().slice(0, 8)}`,
          idpEntityId: idp.entityId,
          idpSsoUrl: 'https://idp.acme.test/sso',
          idpCertificates: [idp.cert],
          jitProvisioning: true,
          enabled: true,
          ...body,
        })
        .expect(201)
    ).body as Connection;

  /** A browser that started a sign-in through `connection`, and its AuthnRequest. */
  const start = async (connection: Connection) => {
    const browser = request.agent(node.app.getHttpServer());
    const login = await browser.get(local(connection.loginUrl)).expect(302);
    return {
      browser,
      location: login.headers.location as string,
      requestId: authnRequestId(login.headers.location as string),
    };
  };

  /** The IdP's POST and the hand-over: where the browser lands. */
  const post = async (
    browser: request.Agent,
    connection: Connection,
    response: string,
  ) => {
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
    return (await browser.get(local(location)).expect(302)).headers
      .location as string;
  };

  const assertion = (
    connection: Connection,
    requestId: string,
    overrides: Partial<SamlResponseOptions> = {},
  ): SamlResponseOptions => ({
    audience: connection.saml.spEntityId,
    acs: connection.saml.acsUrl,
    nameId: `employee-${randomUUID()}`,
    email: `${randomUUID().slice(0, 8)}@${DOMAIN}`,
    inResponseTo: requestId,
    ...overrides,
  });

  const failed = (location: string) =>
    new URL(location).searchParams.get('error') === 'sso_failed';

  /** A sign-in through `connection`: the browser, signed in or not. */
  const signIn = async (
    connection: Connection,
    overrides: Partial<SamlResponseOptions> = {},
  ) => {
    const { browser, requestId } = await start(connection);
    const options = assertion(connection, requestId, overrides);
    const landed = await post(browser, connection, samlResponse(idp, options));
    return { browser, landed, options };
  };

  describe('strict SAML', () => {
    let connection: Connection;

    beforeAll(async () => {
      connection = await connect(node.admin());
    });

    it('signs its AuthnRequests with its own key, published in its metadata', async () => {
      expect(connection.saml.spCertificate.pem).toContain('BEGIN CERTIFICATE');
      const metadata = await node
        .http()
        .get(local(connection.saml.metadataUrl))
        .expect(200);
      expect(metadata.text).toContain('AuthnRequestsSigned="true"');
      expect(metadata.text).toContain('use="encryption"');
      expect(metadata.text).toContain('use="signing"');
      // HTTP-Redirect binding: the signature is over the query string as sent.
      const { location } = await start(connection);
      const query = location.slice(location.indexOf('?') + 1).split('&');
      const signature = query.find((part) => part.startsWith('Signature='))!;
      expect(query.find((part) => part.startsWith('SigAlg='))).toBe(
        `SigAlg=${encodeURIComponent('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256')}`,
      );
      const signed = query
        .filter((part) => !part.startsWith('Signature='))
        .join('&');
      expect(
        verify(
          'sha256',
          Buffer.from(signed),
          connection.saml.spCertificate.pem,
          Buffer.from(
            decodeURIComponent(signature.slice('Signature='.length)),
            'base64',
          ),
        ),
      ).toBe(true);
    });

    it('refuses a Response that is not signed, around a signed assertion', async () => {
      const { browser, landed } = await signIn(connection, {
        signResponse: false,
      });
      expect(failed(landed)).toBe(true);
      await browser.get('/v1/auth/me').expect(401);
      expect((await refusals())[0]).toMatch(/^response_invalid:/);
    });

    it('refuses SHA-1 signatures, which the XML library would accept', async () => {
      const { browser, landed } = await signIn(connection, { sha1: true });
      expect(failed(landed)).toBe(true);
      await browser.get('/v1/auth/me').expect(401);
      expect((await refusals())[0]).toMatch(
        /^algorithm_refused:signature:http:\/\/www\.w3\.org\/2000\/09\/xmldsig#rsa-sha1/,
      );
    });

    it('decrypts an assertion encrypted to its certificate', async () => {
      const { browser, requestId } = await start(connection);
      const options = assertion(connection, requestId);
      const landed = await post(
        browser,
        connection,
        await encryptedSamlResponse(
          idp,
          options,
          connection.saml.spCertificate.pem,
        ),
      );
      expect(failed(landed)).toBe(false);
      const me = await browser.get('/v1/auth/me').expect(200);
      expect(me.body.user.email).toBe(options.email);
    });

    it('refuses RSA PKCS#1 v1.5 key transport', async () => {
      const { browser, requestId } = await start(connection);
      const landed = await post(
        browser,
        connection,
        await encryptedSamlResponse(
          idp,
          assertion(connection, requestId),
          connection.saml.spCertificate.pem,
          {
            keyEncryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#rsa-1_5',
          },
        ),
      );
      expect(failed(landed)).toBe(true);
      expect((await refusals())[0]).toBe(
        'algorithm_refused:encryption:http://www.w3.org/2001/04/xmlenc#rsa-1_5',
      );
    });

    it('requires an encrypted assertion when the connection says so', async () => {
      const encrypted = await connect(node.admin(), {
        requireEncryptedAssertions: true,
      });
      const plain = await signIn(encrypted);
      expect(failed(plain.landed)).toBe(true);
      expect((await refusals())[0]).toBe('assertion_not_encrypted');
      const { browser, requestId } = await start(encrypted);
      const landed = await post(
        browser,
        encrypted,
        await encryptedSamlResponse(
          idp,
          assertion(encrypted, requestId),
          encrypted.saml.spCertificate.pem,
        ),
      );
      expect(failed(landed)).toBe(false);
      await browser.get('/v1/auth/me').expect(200);
    });
  });

  describe('roles from the IdP', () => {
    let editor: string;
    let viewer: string;
    let connection: Connection;

    beforeAll(async () => {
      [editor, viewer] = await node.roleIds('editor', 'viewer');
      connection = await connect(node.admin(), {
        roleMappings: [{ group: 'editors', roleId: editor }],
        defaultRoleIds: [viewer],
      });
    });

    const rolesOf = async (userId: string) =>
      (
        (await node.admin().get(`/v1/access/users/${userId}`).expect(200))
          .body as { roleIds: string[] }
      ).roleIds.sort();

    it('shows the mappings, and refuses one its author could not grant', async () => {
      expect(connection.roleMappings).toEqual([
        { group: 'editors', roleId: editor },
      ]);
      expect(connection.defaultRoleIds).toEqual([viewer]);
      // Access.manageSso alone: no handing out the administrator role.
      const role = await node
        .admin()
        .post('/v1/access/roles')
        .send({
          name: `sso-admins-${randomUUID().slice(0, 8)}`,
          permissions: [
            { subject: 'Access', action: 'manageSso', conditions: [] },
          ],
        })
        .expect(201);
      const ssoAdmin = await node.user([role.body.id]);
      const [administrator] = await node.roleIds('administrator');
      await ssoAdmin.agent
        .post('/v1/sso/connections')
        .send({
          protocol: 'saml',
          name: `escalate-${randomUUID().slice(0, 8)}`,
          idpEntityId: idp.entityId,
          idpSsoUrl: 'https://idp.acme.test/sso',
          idpCertificates: [idp.cert],
          roleMappings: [{ group: 'me', roleId: administrator }],
        })
        .expect(403);
    });

    it('grants the default roles once, and the groups’ roles at each sign-in', async () => {
      const first = await signIn(connection, {
        attributes: { groups: ['editors', 'unmapped'] },
      });
      const me = await first.browser.get('/v1/auth/me').expect(200);
      const userId = me.body.user.id as string;
      expect(await rolesOf(userId)).toEqual([editor, viewer].sort());

      // The IdP no longer lists the group: the role it gave goes; the default stays.
      await signIn(connection, {
        nameId: first.options.nameId,
        email: first.options.email,
        attributes: { groups: [] },
      });
      expect(await rolesOf(userId)).toEqual([viewer]);
      const synced = await node.auditEntries({
        action: 'sso.roles-synced',
        targetId: userId,
      });
      expect(synced[0].details).toMatchObject({
        added: [],
        removed: [editor],
      });

      // An administrator's own grant is theirs: the IdP doesn't take it back.
      await node
        .admin()
        .patch(`/v1/access/users/${userId}`)
        .send({ roleIds: [viewer, editor] })
        .expect(204);
      await signIn(connection, {
        nameId: first.options.nameId,
        email: first.options.email,
      });
      expect(await rolesOf(userId)).toEqual([editor, viewer].sort());
    });

    it('reads the groups from the attribute the connection names', async () => {
      const custom = await connect(node.admin(), {
        groupsAttribute: 'memberOf',
        roleMappings: [{ group: 'cn=editors', roleId: editor }],
      });
      const { browser } = await signIn(custom, {
        attributes: { memberOf: ['cn=editors'], groups: ['ignored'] },
      });
      const me = await browser.get('/v1/auth/me').expect(200);
      expect(await rolesOf(me.body.user.id)).toEqual([editor]);
    });
  });

  describe('SSO required', () => {
    const BETA = 'beta.test';
    let tenant: Awaited<ReturnType<TestApp['otherTenant']>>;
    let adminId: string;

    beforeAll(async () => {
      tenant = await node.otherTenant();
      await verifyDomain(node, dns, tenant.admin, tenant.id, BETA);
      adminId = (await tenant.admin.get('/v1/auth/me').expect(200)).body.user
        .id;
    });

    const setPolicy = (requireSso: boolean) =>
      tenant.admin.put('/v1/sso/policy').send({ requireSso });

    it('is refused while it would lock everyone out', async () => {
      const none = await setPolicy(true).expect(409);
      expect(none.body.code).toBe('sso_connection_required');
      await connect(tenant.admin);
      // Signed in with a password, not exempted: they would lock themselves out.
      const lockout = await setPolicy(true).expect(409);
      expect(lockout.body.code).toBe('sso_lockout');
    });

    it('restricts every other way in, save the exempted', async () => {
      const member = await tenant.user(['viewer']);
      // Break-glass needs two-factor: never a password alone around the IdP.
      const noMfa = await tenant.admin
        .put(`/v1/sso/exemptions/${adminId}`)
        .send({ reason: 'Break-glass administrator' })
        .expect(409);
      expect(noMfa.body.code).toBe('sso_exemption_needs_mfa');
      const enrollment = await tenant.admin
        .post('/v1/auth/mfa/enroll')
        .expect(200);
      const confirmed = await tenant.admin
        .post('/v1/auth/mfa/confirm')
        .send({ code: totp(enrollment.body.secret) })
        .expect(200);
      const [recoveryCode] = confirmed.body.recoveryCodes as string[];
      await tenant.admin
        .put(`/v1/sso/exemptions/${adminId}`)
        .send({ reason: 'Break-glass administrator' })
        .expect(200);
      const policy = await setPolicy(true).expect(200);
      expect(policy.body).toMatchObject({
        requireSso: true,
        exemptions: [{ userId: adminId, reason: 'Break-glass administrator' }],
      });

      // A password session already open: only who-am-I and the way out.
      await member.agent.get('/v1/auth/me').expect(200);
      await member.agent.get('/v1/auth/tenants').expect(200);
      const restricted = await member.agent
        .get('/v1/auth/sessions')
        .expect(403);
      expect(restricted.body.code).toBe('sso_required');

      // A new password sign-in, and a token for that tenant: refused.
      const password = await node
        .http()
        .post('/v1/auth/sign-in')
        .send({ email: member.email, password: member.password })
        .expect(403);
      expect(password.body.code).toBe('sso_required');
      const token = await node
        .http()
        .post('/v1/auth/token')
        .send({
          email: member.email,
          password: member.password,
          tenantId: tenant.id,
        })
        .expect(403);
      expect(token.body.code).toBe('sso_required');

      // The exempted administrator signs in with their password, audited.
      const breakGlass = await node.signIn(tenant.email, tenant.password);
      await breakGlass
        .post('/v1/auth/mfa/verify')
        .send({ recoveryCode })
        .expect(200, { signedIn: true, mfaRequired: false });
      await breakGlass.get('/v1/auth/sessions').expect(200);
      expect(
        await node.auditEntries({
          action: 'sso.exemption-used',
          targetId: adminId,
        }),
      ).toHaveLength(1);
      // Their own exemption is how they are in: not removable from here.
      const own = await breakGlass
        .delete(`/v1/sso/exemptions/${adminId}`)
        .expect(409);
      expect(own.body.code).toBe('sso_lockout');

      // Off again: the open session is free.
      await setPolicy(false).expect(200);
      await member.agent.get('/v1/auth/sessions').expect(200);
    });

    it('lets a session signed in through the tenant’s own connection in', async () => {
      const connection = (
        await tenant.admin.get('/v1/sso/connections').expect(200)
      ).body.items[0] as Connection;
      await setPolicy(true).expect(200);
      const { browser, landed } = await signIn(connection, {
        email: `${randomUUID().slice(0, 8)}@${BETA}`,
      });
      expect(failed(landed)).toBe(false);
      await browser.get('/v1/auth/sessions').expect(200);
      await setPolicy(false).expect(200);
    });
  });

  describe('finding the connection by address', () => {
    const discover = (email: string) =>
      node.http().post('/v1/auth/sso/discover').send({ email }).expect(200);

    it("answers with a login URL for a verified domain's connection only", async () => {
      const { body } = await discover(`someone@${DOMAIN.toUpperCase()}`);
      expect(body.loginUrl).toMatch(
        new RegExp(`/v1/auth/sso/${node.tenantId}/[0-9a-f-]{36}/login$`),
      );
      // The same for any address of the domain: nothing about accounts.
      expect((await discover(`nobody-${randomUUID()}@${DOMAIN}`)).body).toEqual(
        body,
      );
      expect(Object.keys(body)).toEqual(['loginUrl']);
      expect((await discover('someone@unknown.test')).body).toEqual({
        loginUrl: null,
      });
      expect((await discover('not an address')).body).toEqual({
        loginUrl: null,
      });
    });
  });
});
