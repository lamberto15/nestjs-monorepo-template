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
    created: [] as Record<string, unknown>[],
    patched: [] as { id: string; body: Record<string, unknown> }[],
    deleted: [] as string[],
    refreshed: [] as string[],
    domainsAdded: [] as string[],
    verified: [] as string[],
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
      const made = (body.protocol === 'saml' ? saml : oidc)({
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
    http.get('/v1/sso/policy', () => HttpResponse.json(policy)),
    http.put('/v1/sso/policy', async ({ request }) => {
      const body = (await request.json()) as { requireSso: boolean };
      calls.policySet.push(body.requireSso);
      policy = { ...policy, requireSso: body.requireSso };
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
