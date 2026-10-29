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
  onboardingRequired: null,
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
  presignedUploads: false,
  ai: true,
  exchangeRates: true,
  mode: 'normal',
  tenancy: 'multi',
  locales: ['en', 'de', 'ar', 'zh', 'ms'],
};

export const problem = (status: number, code: string, extra: object = {}) =>
  HttpResponse.json(
    { status, code, detail: `${code} (test)`, ...extra },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

export const handlers = [
  // report-error.ts's `send`: any test that triggers an error report (a
  // thrown render, an unhandled rejection) must not also need a handler for it.
  http.post('/v1/client-errors', () => new HttpResponse(null, { status: 204 })),
  http.get('/v1/auth/me', () => problem(401, 'unauthorized')),
  http.get('/v1/auth/methods', () => HttpResponse.json(allMethods)),
  http.get('/v1/features', () => HttpResponse.json(allFeatures)),
  http.get('/v1/settings', () => HttpResponse.json({ items: [] })),
  // The sidebar's favorites, asked on every signed-in page: none, unless a test says so.
  http.get('/v1/favorites', () => HttpResponse.json({ items: [] })),
  // The work surfaces (docs/work-surfaces.md), asked on every signed-in page
  // and record: an empty inbox and history, nobody else on the record.
  http.get('/v1/inbox', () =>
    HttpResponse.json({ items: [], nextCursor: null }),
  ),
  http.get('/v1/recents', () => HttpResponse.json({ items: [] })),
  http.post('/v1/recents', async ({ request }) =>
    HttpResponse.json({
      id: '0199a3f2-0000-7000-8000-00000000f001',
      ...((await request.json()) as object),
      viewedAt: new Date().toISOString(),
    }),
  ),
  http.get('/v1/presence/:subject/:recordId', () =>
    HttpResponse.json({ items: [] }),
  ),
  http.put('/v1/presence/:subject/:recordId', () =>
    HttpResponse.json({ items: [] }),
  ),
  http.delete(
    '/v1/presence/:subject/:recordId',
    () => new HttpResponse(null, { status: 204 }),
  ),
  // The sidebar's approvals badge asks for its count on every signed-in page.
  http.get('/v1/approvals', () =>
    HttpResponse.json({ items: [], nextCursor: null, total: 0 }),
  ),
  // The tenant's branding (docs/branding.md), read on every signed-in page: none, unless a test says so.
  http.get('/v1/branding', () =>
    HttpResponse.json({
      primaryColor: null,
      darkPrimaryColor: null,
      mailFromName: null,
      logoUrl: null,
      darkLogoUrl: null,
      locked: false,
      canEdit: false,
    }),
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
