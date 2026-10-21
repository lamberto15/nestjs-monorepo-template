import { http, HttpResponse } from 'msw/http';
import { problem, server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';
import type { Connection, Domain, Policy } from '../queries';

// The SSO routes in memory (msw), recording what the pages sent.

const TENANT = '11111111-1111-4111-8111-111111111111';

export const oidc = (over: Partial<Connection> = {}): Connection => ({
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Okta',
  protocol: 'oidc',
  enabled: false,
  jitProvisioning: false,
  loginUrl: `/v1/auth/sso/${TENANT}/22222222-2222-4222-8222-222222222222/login`,
  oidc: {
    issuer: 'https://acme.okta.com',
    clientId: 'abc',
    redirectUri: 'https://app.example.com/v1/auth/sso/cb',
    metadataFetchedAt: '2026-10-17T09:00:00.000Z',
    metadataError: null,
  },
  saml: null,
  oauth2: null,
  createdAt: '2026-10-17T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
  ...over,
});

export const oauth2 = (over: Partial<Connection> = {}): Connection => ({
  id: '77777777-7777-4777-8777-777777777777',
  name: 'Lark',
  protocol: 'oauth2',
  enabled: true,
  jitProvisioning: false,
  loginUrl: `/v1/auth/sso/${TENANT}/77777777-7777-4777-8777-777777777777/login`,
  oidc: null,
  saml: null,
  oauth2: {
    authorizationEndpoint:
      'https://accounts.larksuite.com/open-apis/authen/v1/authorize',
    tokenEndpoint: 'https://open.larksuite.com/open-apis/authen/v2/oauth/token',
    userinfoEndpoint:
      'https://open.larksuite.com/open-apis/authen/v1/user_info',
    clientId: 'cli_a1b2c3',
    tokenEndpointAuthMethod: 'client_secret_post',
    scopes: ['contact:user.email:readonly'],
    mapping: {
      root: 'data',
      subject: 'open_id',
      email: 'enterprise_email',
      name: 'name',
      emailVerified: 'verified-domains',
      errorCode: 'code',
    },
    preset: { name: 'lark', region: 'lark' },
    redirectUri: 'https://app.example.com/v1/auth/sso/oauth2/callback',
  },
  createdAt: '2026-10-17T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
  ...over,
});

export const saml = (over: Partial<Connection> = {}): Connection => ({
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Entra',
  protocol: 'saml',
  enabled: true,
  jitProvisioning: true,
  loginUrl: `/v1/auth/sso/${TENANT}/33333333-3333-4333-8333-333333333333/login`,
  oidc: null,
  oauth2: null,
  saml: {
    idpEntityId: 'https://sts.example.com/idp',
    idpSsoUrl: 'https://sts.example.com/sso',
    idpCertificates: [
      {
        subject: 'CN=idp',
        notAfter: '2030-01-01T00:00:00.000Z',
        fingerprint256: 'AA:BB',
      },
    ],
    allowIdpInitiated: false,
    spEntityId: 'https://app.example.com/v1/auth/sso/saml/metadata',
    acsUrl: 'https://app.example.com/v1/auth/sso/saml/acs',
    metadataUrl: 'https://app.example.com/v1/auth/sso/saml/metadata',
  },
  createdAt: '2026-10-17T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
  ...over,
});

export const domain = (over: Partial<Domain> = {}): Domain => ({
  id: '44444444-4444-4444-8444-444444444444',
  domain: 'acme.com',
  verified: false,
  verifiedAt: null,
  lastCheckedAt: null,
  lastError: null,
  record: {
    type: 'TXT',
    name: '_sso-verification.acme.com',
    value: 'sso-verification=token',
  },
  createdAt: '2026-10-17T09:00:00.000Z',
  ...over,
});

export const ROLE_ID = '88888888-8888-4888-8888-888888888888';
export const MEMBER_ID = '99999999-9999-4999-8999-999999999999';

export function useSsoApi(options: {
  can: string[];
  connections?: Connection[];
  domains?: Domain[];
  policy?: Policy;
}) {
  let connections = [...(options.connections ?? [oidc(), saml()])];
  let domains = [...(options.domains ?? [domain()])];
  let policy: Policy = options.policy ?? {
    requireSso: false,
    updatedAt: null,
    exemptions: [],
  };
  const calls = {
    policySet: [] as boolean[],
    exemptionsEnded: [] as string[],
    exemptionsAdded: [] as { userId: string; reason: string }[],
    created: [] as Record<string, unknown>[],
    patched: [] as { id: string; body: Record<string, unknown> }[],
    deleted: [] as string[],
    refreshed: [] as string[],
    domainsAdded: [] as string[],
    verified: [] as string[],
    metadataImports: [] as string[],
    reads: 0,
  };
  useSignedIn(options.can);
  server.use(
    http.get('/v1/sso/connections', () => {
      calls.reads += 1;
      return HttpResponse.json({ items: connections });
    }),
    http.post('/v1/sso/connections', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.created.push(body);
      // A token URL on http is refused, as the API does (400 on its field).
      if (
        typeof body.tokenEndpoint === 'string' &&
        body.tokenEndpoint.startsWith('http://')
      ) {
        return problem(400, 'validation_failed', {
          errors: [
            { path: 'tokenEndpoint', message: 'Must be an https URL.' },
            { path: 'mapping.subject', message: 'Unknown path.' },
          ],
        });
      }
      const made = ({ saml, oauth2, oidc } as Record<string, typeof oidc>)[
        body.protocol as string
      ]!({
        id: '55555555-5555-4555-8555-555555555555',
        name: body.name as string,
        enabled: body.enabled === true,
      });
      connections = [...connections, made];
      return HttpResponse.json(made, { status: 201 });
    }),
    http.patch('/v1/sso/connections/:id', async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.patched.push({ id: params.id as string, body });
      const found = connections.find((c) => c.id === params.id);
      if (!found) return problem(404, 'not_found');
      const saved = { ...found, ...body } as Connection;
      connections = connections.map((c) => (c.id === saved.id ? saved : c));
      return HttpResponse.json(saved);
    }),
    http.delete('/v1/sso/connections/:id', ({ params }) => {
      calls.deleted.push(params.id as string);
      connections = connections.filter((c) => c.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/v1/sso/connections/:id/refresh', ({ params }) => {
      calls.refreshed.push(params.id as string);
      return HttpResponse.json({ accepted: true }, { status: 202 });
    }),
    http.post('/v1/sso/saml/metadata', async ({ request }) => {
      const body = (await request.json()) as { url: string };
      calls.metadataImports.push(body.url);
      return HttpResponse.json({
        idpEntityId: 'https://meta.example.com/idp',
        idpSsoUrl: 'https://meta.example.com/sso',
        idpCertificates: ['PEM-A', 'PEM-B'],
      });
    }),
    http.get('/v1/sso/policy', () => HttpResponse.json(policy)),
    http.put('/v1/sso/policy', async ({ request }) => {
      const body = (await request.json()) as { requireSso: boolean };
      calls.policySet.push(body.requireSso);
      policy = { ...policy, requireSso: body.requireSso };
      return HttpResponse.json(policy);
    }),
    // The roles and members the dialogs offer (the access API).
    http.get('/v1/access/roles', () =>
      HttpResponse.json({ items: [{ id: ROLE_ID, name: 'Editor' }] }),
    ),
    http.get('/v1/access/users', () =>
      HttpResponse.json({
        items: [
          { id: MEMBER_ID, email: 'ann@acme.com', name: 'Ann', active: true },
          {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            email: 'off@acme.com',
            name: 'Off',
            active: false,
          },
        ],
        page: 1,
        nextPage: null,
        pageCount: 1,
        total: 2,
      }),
    ),
    http.put('/v1/sso/exemptions/:userId', async ({ params, request }) => {
      const body = (await request.json()) as { reason: string };
      calls.exemptionsAdded.push({
        userId: params.userId as string,
        reason: body.reason,
      });
      return HttpResponse.json(policy);
    }),
    http.delete('/v1/sso/exemptions/:userId', ({ params }) => {
      calls.exemptionsEnded.push(params.userId as string);
      policy = {
        ...policy,
        exemptions: policy.exemptions.filter((e) => e.userId !== params.userId),
      };
      return new HttpResponse(null, { status: 204 });
    }),
    http.get('/v1/sso/domains', () => HttpResponse.json({ items: domains })),
    http.post('/v1/sso/domains', async ({ request }) => {
      const body = (await request.json()) as { domain: string };
      calls.domainsAdded.push(body.domain);
      const made = domain({
        id: '66666666-6666-4666-8666-666666666666',
        domain: body.domain,
      });
      domains = [...domains, made];
      return HttpResponse.json(made, { status: 201 });
    }),
    http.post('/v1/sso/domains/:id/verify', ({ params }) => {
      calls.verified.push(params.id as string);
      return HttpResponse.json({ accepted: true }, { status: 202 });
    }),
  );
  return { calls };
}
