import { http, HttpResponse } from 'msw/http';
import { setupServer } from 'msw/node';
import type { Features, Me, Methods } from '@/lib/session';

// The API as the tests see it (msw intercepts the client's fetch). Each
// test overrides what it needs with server.use().

export const signedInUser: Me = {
  user: {
    kind: 'user',
    id: '0199a3f2-0000-7000-8000-000000000001',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    emailVerified: true,
    locale: null,
    timezone: null,
    tenantId: '0199a3f2-0000-7000-8000-0000000000aa',
  },
  tenant: {
    id: '0199a3f2-0000-7000-8000-0000000000aa',
    slug: 'acme',
    name: 'Acme',
    operator: true,
  },
  mfaEnabled: false,
  hasPassword: true,
  mfaEnrollmentRequired: false,
  authentication: {
    via: 'session',
    method: 'password',
    provider: null,
    mfa: false,
    authenticatedAt: '2026-10-17T09:00:00.000Z',
    recentUntil: '2026-10-17T09:10:00.000Z',
  },
  can: {},
};

export const allMethods: Methods = {
  password: true,
  signUp: true,
  magicLink: true,
  passkeys: false,
  providers: ['google'],
  captcha: null,
};

export const allFeatures: Features = {
  realtime: true,
  webhooks: true,
  reports: true,
  usage: true,
  impersonation: false,
  mfa: true,
  apiClients: true,
  passkeys: true,
  signUp: false,
  magicLink: true,
  documents: true,
  ai: true,
  exchangeRates: true,
  tenancy: 'multi',
  locales: ['en', 'de', 'ar', 'zh', 'ms'],
};

export const problem = (status: number, code: string, extra: object = {}) =>
  HttpResponse.json(
    { status, code, detail: `${code} (test)`, ...extra },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

export const handlers = [
  http.get('/v1/auth/me', () => problem(401, 'unauthorized')),
  http.get('/v1/auth/methods', () => HttpResponse.json(allMethods)),
  http.get('/v1/features', () => HttpResponse.json(allFeatures)),
  // The sidebar's approvals badge asks for its count on every signed-in page.
  http.get('/v1/approvals', () =>
    HttpResponse.json({ items: [], nextCursor: null, total: 0 }),
  ),
  // The dashboard's unread-notifications card asks on the home page.
  http.get('/v1/notifications', () =>
    HttpResponse.json({ items: [], nextCursor: null }),
  ),
  http.get('/v1/auth/tenants', () =>
    HttpResponse.json({
      items: [
        {
          id: signedInUser.tenant!.id,
          slug: 'acme',
          name: 'Acme',
          current: true,
        },
      ],
    }),
  ),
];

export const server = setupServer(...handlers);
