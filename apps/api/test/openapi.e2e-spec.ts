import { bootApp, type TestApp } from './support.js';

describe('OpenAPI document (e2e)', () => {
  let node: TestApp;
  let document: {
    paths: Record<string, Record<string, any>>;
    components: { securitySchemes: Record<string, unknown> };
  };

  beforeAll(async () => {
    node = await bootApp();
    document = (await node.http().get('/api-json').expect(200)).body;
  });

  afterAll(async () => {
    await node.close();
  });

  it('documents the optional total of paginated lists', () => {
    const list = document.paths['/v1/notes'].get;
    expect(
      list.parameters.map((parameter: { name: string }) => parameter.name),
    ).toContain('count');
    const response = JSON.stringify(list.responses['200']);
    expect(response).toContain('"total"');
    expect(response).toContain('"totalCapped"');
  });

  it('gives every operation its own operationId (the typed client keys them)', () => {
    const ids = Object.values(document.paths).flatMap((operations) =>
      Object.values(operations).map(
        (operation: { operationId: string }) => operation.operationId,
      ),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('serves Swagger UI', async () => {
    await node.http().get('/api').expect(200);
  });

  it('documents every route but the health checks and /files', () => {
    expect(Object.keys(document.paths).sort()).toEqual([
      '/v1/access/audit',
      '/v1/access/catalog',
      '/v1/access/clients',
      '/v1/access/clients/{id}',
      '/v1/access/clients/{id}/keys/{keyId}',
      '/v1/access/clients/{id}/rotate',
      '/v1/access/clients/{id}/usage',
      '/v1/access/invitations',
      '/v1/access/invitations/{id}',
      '/v1/access/teams',
      '/v1/access/teams/{id}',
      '/v1/access/roles',
      '/v1/access/roles/{id}',
      '/v1/access/users',
      '/v1/access/users/{id}',
      '/v1/access/users/{id}/impersonate',
      '/v1/account',
      '/v1/account/consents',
      '/v1/account/deletion',
      '/v1/account/deletion/cancel',
      '/v1/account/export',
      '/v1/approvals',
      '/v1/approvals/delegations',
      '/v1/approvals/delegations/{id}',
      '/v1/approvals/policies',
      '/v1/approvals/policies/{key}',
      '/v1/approvals/policy-types',
      '/v1/approvals/{id}',
      '/v1/approvals/{id}/abandon',
      '/v1/approvals/{id}/approve',
      '/v1/approvals/{id}/cancel',
      '/v1/approvals/{id}/reject',
      '/v1/approvals/{id}/request-changes',
      '/v1/approvals/{id}/resubmit',
      '/v1/attachments/{id}',
      '/v1/attachments/{id}/download',
      '/v1/auth/email/verification',
      '/v1/auth/email/verify',
      '/v1/auth/identities',
      '/v1/auth/identities/{provider}',
      '/v1/auth/impersonation/stop',
      '/v1/auth/invitations/accept',
      '/v1/auth/magic-link',
      '/v1/auth/magic-link/verify',
      '/v1/auth/me',
      '/v1/auth/methods',
      '/v1/auth/mfa',
      '/v1/auth/mfa/confirm',
      '/v1/auth/mfa/enroll',
      '/v1/auth/mfa/recovery-codes',
      '/v1/auth/mfa/verify',
      '/v1/auth/oidc/{provider}/callback',
      '/v1/auth/oidc/{provider}/login',
      '/v1/auth/passkeys',
      '/v1/auth/passkeys/reauthentication/options',
      '/v1/auth/passkeys/registration/options',
      '/v1/auth/passkeys/sign-in',
      '/v1/auth/passkeys/sign-in/options',
      '/v1/auth/passkeys/token',
      '/v1/auth/passkeys/{id}',
      '/v1/auth/password/change',
      '/v1/auth/password/forgot',
      '/v1/auth/password/reset',
      '/v1/auth/reauthenticate',
      '/v1/auth/sessions',
      '/v1/auth/sessions/{id}',
      '/v1/auth/sign-in',
      '/v1/auth/sign-out',
      '/v1/auth/sign-out-everywhere',
      '/v1/auth/sign-up',
      '/v1/auth/tenant',
      '/v1/auth/tenants',
      '/v1/auth/token',
      '/v1/auth/token/refresh',
      '/v1/auth/token/revoke',
      '/v1/bulk/{id}',
      '/v1/custom-fields',
      '/v1/custom-fields/order',
      '/v1/custom-fields/{id}',
      '/v1/data',
      '/v1/data/exports',
      '/v1/data/imports',
      '/v1/data/imports/{name}/template',
      '/v1/data/transfers/{id}',
      '/v1/documents/{id}',
      '/v1/mail/suppressions',
      '/v1/mail/suppressions/{id}',
      '/v1/money/convert',
      '/v1/money/rates',
      '/v1/notes',
      '/v1/notes/bulk',
      '/v1/notes/{id}',
      '/v1/notes/{id}/attachments',
      '/v1/notes/{id}/comments',
      '/v1/notes/{id}/comments/{commentId}',
      '/v1/notes/{id}/pdf',
      '/v1/notes/{id}/restore',
      '/v1/notes/{id}/revisions',
      '/v1/notes/{id}/revisions/{a}/diff/{b}',
      '/v1/notes/{id}/revisions/{number}',
      '/v1/notes/{id}/revisions/{number}/restore',
      '/v1/notes/{id}/tags',
      '/v1/notes/{id}/watch',
      '/v1/notifications',
      '/v1/notifications/preferences',
      '/v1/notifications/read-all',
      '/v1/notifications/types',
      '/v1/notifications/unread-count',
      '/v1/notifications/{id}',
      '/v1/notifications/{id}/read',
      '/v1/ops/dead-letters/purge',
      '/v1/ops/dead-letters/requeue',
      '/v1/ops/events',
      '/v1/ops/outbox',
      '/v1/ops/queues',
      '/v1/ops/queues/{name}/retry-failed',
      '/v1/reports',
      '/v1/reports/{id}',
      '/v1/reports/{id}/run',
      '/v1/search',
      '/v1/settings',
      '/v1/settings/{key}',
      '/v1/settings/{key}/mine',
      '/v1/settings/{key}/overrides',
      '/v1/subscriptions',
      '/v1/subscriptions/{subject}/{recordId}',
      '/v1/tags',
      '/v1/tags/{id}',
      '/v1/tenants',
      '/v1/usage',
      '/v1/webhook-deliveries',
      '/v1/webhook-deliveries/retry',
      '/v1/webhook-deliveries/{id}',
      '/v1/webhook-deliveries/{id}/retry',
      '/v1/webhook-endpoints',
      '/v1/webhook-endpoints/{id}',
      '/v1/webhook-endpoints/{id}/rotate-secret',
      '/v1/webhooks/example-sender',
      '/v1/webhooks/mail/{provider}',
    ]);
  });

  it('turns the Zod schemas into request bodies and responses', () => {
    const create = document.paths['/v1/notes'].post;
    expect(create.requestBody.content['application/json'].schema).toMatchObject(
      {
        type: 'object',
        required: ['title', 'body'],
      },
    );
    expect(
      create.responses['201'].content['application/json'].schema.properties,
    ).toHaveProperty('status');
  });

  it('documents the import upload, so Swagger UI offers a file picker', () => {
    const body =
      document.paths['/v1/data/imports'].post.requestBody.content[
        'multipart/form-data'
      ].schema;
    expect(body.properties.file).toMatchObject({
      type: 'string',
      format: 'binary',
    });
    expect(Object.keys(body.properties)).toEqual(['name', 'dryRun', 'file']);
  });

  it('pre-fills Idempotency-Key with "generate", which Swagger UI swaps for a fresh key', async () => {
    const header = document.paths['/v1/notes'].post.parameters.find(
      (parameter: { name: string }) => parameter.name === 'Idempotency-Key',
    );
    expect(header).toMatchObject({
      in: 'header',
      required: true,
      schema: { example: 'generate' },
    });
    const init = await node.http().get('/api/swagger-ui-init.js').expect(200);
    expect(init.text).toContain('crypto.randomUUID()');
  });

  it('documents the three credentials: API key, user session, user token', () => {
    expect(Object.keys(document.components.securitySchemes).sort()).toEqual([
      'api-key',
      'user-session',
      'user-token',
    ]);
  });
});
