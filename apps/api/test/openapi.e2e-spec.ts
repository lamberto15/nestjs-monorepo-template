import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppModule, createAppModule } from '../src/app.module.js';
import { FEATURES } from '../src/features/index.js';
import { TEST_ITEMS_FEATURE } from './fixtures/test-items/test-items.feature.js';
import { bootApp, type TestApp } from './support.js';

/** Whether a path belongs to a feature (features/index.ts): its tag's routes or its incoming webhooks. */
function isFeaturePath(path: string) {
  return FEATURES.some((feature) => {
    const bases = [
      `/v1/${feature.apiTag.name}`,
      ...(feature.incomingWebhooks ?? []).map(
        (webhook) => `/v1/webhooks/${webhook.name}`,
      ),
    ];
    return bases.some((base) => path === base || path.startsWith(`${base}/`));
  });
}

/** The components the record panels share (src/platform/records/panel-components.ts). */
const PANEL_COMPONENTS = [
  'Comment',
  'CommentPage',
  'Attachment',
  'AttachmentPage',
  'PresignedUpload',
  'Tag',
  'TagPage',
  'TagRef',
  'TagRefList',
  'Revision',
  'RevisionPage',
  'RevisionDiff',
  'RecordDocument',
  'RecordDocumentPage',
];

describe('OpenAPI document (e2e)', () => {
  let node: TestApp;
  let document: {
    paths: Record<string, Record<string, any>>;
    components: { securitySchemes: Record<string, unknown> };
  };

  beforeAll(async () => {
    // The app's document: without the test-only features (test/fixtures).
    node = await bootApp(undefined, undefined, { module: AppModule });
    document = (await node.http().get('/api-json').expect(200)).body;
  });

  afterAll(async () => {
    await node.close();
  });

  it('gives every operation its own operationId (the typed client keys them)', () => {
    const ids = Object.values(document.paths).flatMap((operations) =>
      Object.values(operations).map(
        (operation: { operationId: string }) => operation.operationId,
      ),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('types the audit log: a page of AuditEntry, each with actorName', () => {
    const schemas = (
      document.components as unknown as { schemas: Record<string, any> }
    ).schemas;
    expect(
      document.paths['/v1/access/audit']!.get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/AuditPage' });
    expect(schemas.AuditPage).toMatchObject({
      properties: {
        items: { items: { $ref: '#/components/schemas/AuditEntry' } },
      },
    });
    expect(schemas.AuditEntry.required).toEqual(
      expect.arrayContaining(['actor', 'actorLabel', 'actorName']),
    );
    expect(schemas.AuditEntry.properties.actorName).toMatchObject({
      type: 'string',
      nullable: true,
    });
  });

  it('types the operations routes: every answer has a schema, the stream a union by source', () => {
    const ok = (path: string, method: string, media = 'application/json') =>
      document.paths[path]![method].responses['200'].content?.[media]?.schema;
    expect(ok('/v1/ops/outbox', 'get').properties).toHaveProperty(
      'deadLetters',
    );
    expect(ok('/v1/ops/queues', 'get').properties).toHaveProperty('items');
    expect(ok('/v1/ops/queues/{name}/retry-failed', 'post').required).toEqual([
      'retried',
    ]);
    expect(ok('/v1/ops/dead-letters/requeue', 'post').required).toEqual([
      'requeued',
    ]);
    expect(ok('/v1/ops/dead-letters/purge', 'post').required).toEqual([
      'purged',
    ]);
    const stream = JSON.stringify(
      ok('/v1/ops/events', 'get', 'text/event-stream'),
    );
    for (const source of [
      'workflow',
      'webhooks',
      'outbox',
      'idempotency',
      'locks',
      'mail',
      'resilience',
    ]) {
      expect(stream).toContain(`"enum":["${source}"]`);
    }
  });

  it('serves Swagger UI', async () => {
    await node.http().get('/api').expect(200);
  });

  it('documents every route but the health checks and /files', () => {
    // The list below holds the routes of the groups and of the features
    // `pnpm feature:add` added (it lists their paths). A feature that is not
    // listed (the example, which a project removes) has its own spec in
    // test/features/, so its paths are left out here, not compared.
    const listed = new Set(
      [
        ...readFileSync(fileURLToPath(import.meta.url), 'utf8').matchAll(
          /^[ \t]+'(\/v1\/[^'\n]*)',$/gm,
        ),
      ].map((match) => match[1]),
    );
    const check = (document: { paths: Record<string, unknown> }) =>
      expect(Object.keys(document.paths).sort()).toEqual([
        '/v1/access/audit',
        '/v1/access/catalog',
        '/v1/access/clients',
        '/v1/access/clients/{clientId}/webhook-deliveries',
        '/v1/access/clients/{clientId}/webhook-deliveries/retry',
        '/v1/access/clients/{clientId}/webhook-deliveries/{id}',
        '/v1/access/clients/{clientId}/webhook-deliveries/{id}/retry',
        '/v1/access/clients/{clientId}/webhook-endpoints',
        '/v1/access/clients/{clientId}/webhook-endpoints/{id}',
        '/v1/access/clients/{clientId}/webhook-endpoints/{id}/rotate-secret',
        '/v1/access/clients/{clientId}/webhook-endpoints/{id}/test',
        '/v1/access/clients/{id}',
        '/v1/access/clients/{id}/keys/{keyId}',
        '/v1/access/clients/{id}/rotate',
        '/v1/access/clients/{id}/usage',
        '/v1/access/invitations',
        '/v1/access/invitations/{id}',
        '/v1/access/invitations/{id}/resend',
        '/v1/access/organizational-units',
        '/v1/access/organizational-units/{id}',
        '/v1/access/organizational-units/{id}/members',
        '/v1/access/organizational-units/{id}/members/{userId}',
        '/v1/access/principals',
        '/v1/access/roles',
        '/v1/access/roles/{id}',
        '/v1/access/sign-ins',
        '/v1/access/users',
        '/v1/access/users/{id}',
        '/v1/access/users/{id}/impersonate',
        '/v1/account',
        '/v1/account/avatar',
        '/v1/account/consent-kinds',
        '/v1/account/consents',
        '/v1/account/consents/{kind}',
        '/v1/account/deletion',
        '/v1/account/deletion/cancel',
        '/v1/account/export',
        '/v1/account/exports',
        '/v1/acknowledgments',
        '/v1/ai/runs',
        '/v1/ai/runs/{id}',
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
        '/v1/attachments/{id}/acknowledge',
        '/v1/attachments/{id}/acknowledgment-requests',
        '/v1/attachments/{id}/acknowledgments',
        '/v1/attachments/{id}/acknowledgments/remind',
        '/v1/attachments/{id}/acknowledgments/{acknowledgmentId}',
        '/v1/attachments/{id}/download',
        '/v1/auth/email/change',
        '/v1/auth/email/verification',
        '/v1/auth/email/verification/resend',
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
        '/v1/auth/sso/discover',
        '/v1/auth/sso/{tenantId}/{connectionId}/login',
        '/v1/auth/sso/{tenantId}/{connectionId}/oauth2/callback',
        '/v1/auth/sso/{tenantId}/{connectionId}/oidc/callback',
        '/v1/auth/sso/{tenantId}/{connectionId}/saml/acs',
        '/v1/auth/sso/{tenantId}/{connectionId}/saml/complete',
        '/v1/auth/sso/{tenantId}/{connectionId}/saml/metadata',
        '/v1/auth/tenant',
        '/v1/auth/tenants',
        '/v1/auth/token',
        '/v1/auth/token/refresh',
        '/v1/auth/token/revoke',
        '/v1/branding',
        '/v1/branding/logo',
        '/v1/branding/{tenantId}/logo',
        '/v1/bulk',
        '/v1/bulk/{id}',
        '/v1/client-errors',
        '/v1/custom-fields',
        '/v1/custom-fields/order',
        '/v1/custom-fields/subjects',
        '/v1/custom-fields/{id}',
        '/v1/data',
        '/v1/data/exports',
        '/v1/data/imports',
        '/v1/data/imports/{name}/mappings',
        '/v1/data/imports/{name}/mappings/{id}',
        '/v1/data/imports/{name}/template',
        '/v1/data/transfers',
        '/v1/data/transfers/{id}',
        '/v1/devices',
        '/v1/devices/{id}',
        '/v1/documents/{id}',
        '/v1/favorites',
        '/v1/favorites/order',
        '/v1/favorites/{id}',
        '/v1/features',
        '/v1/legal-holds',
        '/v1/legal-holds/{id}',
        '/v1/legal-holds/{id}/release',
        '/v1/lists/{subject}',
        '/v1/mail/suppressions',
        '/v1/mail/suppressions/{id}',
        '/v1/messaging/phone',
        '/v1/messaging/phone/verify',
        '/v1/money/convert',
        '/v1/money/rates',
        '/v1/naming-series',
        '/v1/naming-series/preview',
        '/v1/naming-series/subjects',
        '/v1/naming-series/variables',
        '/v1/naming-series/{id}',
        '/v1/naming-series/{id}/counter',
        '/v1/notifications',
        '/v1/notifications/preferences',
        '/v1/notifications/quiet-hours',
        '/v1/notifications/read-all',
        '/v1/notifications/test',
        '/v1/notifications/types',
        '/v1/notifications/unread-count',
        '/v1/notifications/unsubscribe/{token}',
        '/v1/notifications/{id}',
        '/v1/notifications/{id}/read',
        '/v1/ops/dead-letters/purge',
        '/v1/ops/dead-letters/requeue',
        '/v1/ops/events',
        '/v1/ops/outbox',
        '/v1/ops/queues',
        '/v1/ops/queues/{name}/retry-failed',
        '/v1/organizational-units',
        '/v1/people',
        '/v1/people/{id}/avatar',
        '/v1/reports',
        '/v1/reports/{id}',
        '/v1/reports/{id}/run',
        '/v1/retention/rules',
        '/v1/retention/rules/{name}',
        '/v1/scim/Groups',
        '/v1/scim/Groups/{id}',
        '/v1/scim/ResourceTypes',
        '/v1/scim/ServiceProviderConfig',
        '/v1/scim/Users',
        '/v1/scim/Users/{id}',
        '/v1/search',
        '/v1/settings',
        '/v1/settings/{key}',
        '/v1/settings/{key}/mine',
        '/v1/settings/{key}/overrides',
        '/v1/settings/{key}/platform',
        '/v1/sso/connections',
        '/v1/sso/connections/{id}',
        '/v1/sso/connections/{id}/refresh',
        '/v1/sso/domains',
        '/v1/sso/domains/{id}',
        '/v1/sso/domains/{id}/verify',
        '/v1/sso/exemptions/{userId}',
        '/v1/sso/policy',
        '/v1/sso/saml/metadata',
        '/v1/subscriptions',
        '/v1/subscriptions/{subject}/{recordId}',
        '/v1/tags',
        '/v1/tags/{id}',
        '/v1/tenant/usage',
        '/v1/tenants',
        '/v1/tenants/{id}',
        '/v1/tenants/{id}/break-glass',
        '/v1/tenants/{id}/break-glass/{grantId}',
        '/v1/tenants/{id}/deletion',
        '/v1/tenants/{id}/export',
        '/v1/tenants/{id}/quotas',
        '/v1/tenants/{id}/usage',
        '/v1/usage',
        '/v1/views',
        '/v1/views/{id}',
        '/v1/views/{id}/apply',
        '/v1/webhook-deliveries',
        '/v1/webhook-deliveries/retry',
        '/v1/webhook-deliveries/{id}',
        '/v1/webhook-deliveries/{id}/retry',
        '/v1/webhook-endpoints',
        '/v1/webhook-endpoints/{id}',
        '/v1/webhook-endpoints/{id}/rotate-secret',
        '/v1/webhook-endpoints/{id}/test',
        '/v1/webhook-event-types',
        '/v1/webhook-incoming-event-types',
        '/v1/webhook-senders',
        '/v1/webhook-senders/{id}',
        '/v1/webhook-senders/{id}/rotate-secret',
        '/v1/webhooks/mail/{provider}',
        '/v1/webhooks/sms/{provider}',
        '/v1/webhooks/tenants/{tenantId}/senders/{name}',
      ]);
    check({
      paths: Object.fromEntries(
        Object.entries(document.paths).filter(
          ([path]) => listed.has(path) || !isFeaturePath(path),
        ),
      ),
    });
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
    expect(Object.keys(body.properties)).toEqual([
      'name',
      'matchOn',
      'mapping',
      'dryRun',
      'file',
    ]);
  });

  it('documents the unsubscribe link twice, both public: the POST unsubscribes, the GET only says what it stops', () => {
    const route = document.paths['/v1/notifications/unsubscribe/{token}']!;
    expect(Object.keys(route).sort((a, b) => a.localeCompare(b))).toEqual([
      'get',
      'post',
    ]);
    for (const operation of Object.values(route)) {
      expect(operation.security ?? []).toEqual([]);
      expect(operation.responses['400']).toBeDefined();
    }
    expect(route.post!.responses['204']).toBeDefined();
    const answer =
      route.get!.responses['200'].content['application/json'].schema;
    expect(
      answer.oneOf.map(
        (shape: { properties: { kind: { enum: string[] } } }) =>
          shape.properties.kind.enum[0],
      ),
    ).toEqual(['type', 'digest']);
  });

  it('pre-fills Idempotency-Key with "generate", which Swagger UI swaps for a fresh key', async () => {
    const header = document.paths['/v1/webhook-endpoints'].post.parameters.find(
      (parameter: { name: string }) => parameter.name === 'Idempotency-Key',
    );
    expect(header).toMatchObject({
      in: 'header',
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

describe("OpenAPI document: the record panels' components (e2e)", () => {
  type Document = {
    paths: Record<string, Record<string, any>>;
    components: { schemas: Record<string, any> };
  };
  let withItems: TestApp;
  let bare: TestApp;
  let full: Document;
  let none: Document;

  beforeAll(async () => {
    // The test-only record has every panel; the other app has no feature.
    withItems = await bootApp(undefined, undefined, {
      module: createAppModule([TEST_ITEMS_FEATURE]),
    });
    bare = await bootApp(undefined, undefined, {
      module: createAppModule([]),
    });
    full = (await withItems.http().get('/api-json').expect(200)).body;
    none = (await bare.http().get('/api-json').expect(200)).body;
  });

  afterAll(async () => {
    await withItems.close();
    await bare.close();
  });

  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const response = (path: string, method: string, status = '200') =>
    full.paths[path][method].responses[status].content['application/json']
      .schema;

  it("names the panels' shapes, which a feature's routes reference", () => {
    for (const name of PANEL_COMPONENTS) {
      expect(full.components.schemas[name]).toBeDefined();
    }
    const base = '/v1/test-items/{id}';
    expect(response(`${base}/comments`, 'get')).toEqual(ref('CommentPage'));
    expect(response(`${base}/comments`, 'post', '201')).toEqual(ref('Comment'));
    expect(response(`${base}/comments/{commentId}`, 'patch')).toEqual(
      ref('Comment'),
    );
    expect(response(`${base}/attachments`, 'get')).toEqual(
      ref('AttachmentPage'),
    );
    expect(response(`${base}/attachments`, 'post', '201')).toEqual(
      ref('Attachment'),
    );
    // Direct uploads to the object store (STORAGE_DRIVER=s3): announce, then complete.
    expect(response(`${base}/attachments/presign`, 'post', '201')).toEqual(
      ref('PresignedUpload'),
    );
    expect(response(`${base}/attachments/complete`, 'post', '201')).toEqual(
      ref('Attachment'),
    );
    expect(response(`${base}/tags`, 'put')).toEqual(ref('TagRefList'));
    expect(response(`${base}/revisions`, 'get')).toEqual(ref('RevisionPage'));
    expect(response(`${base}/revisions/{number}`, 'get')).toEqual(
      ref('Revision'),
    );
    expect(response(`${base}/revisions/{a}/diff/{b}`, 'get')).toEqual(
      ref('RevisionDiff'),
    );
    expect(response(`${base}/documents`, 'get')).toEqual(
      ref('RecordDocumentPage'),
    );
    expect(response('/v1/tags', 'get')).toEqual(ref('TagPage'));
    // The pages hold the item components, not copies of them.
    expect(full.components.schemas.CommentPage).toMatchObject({
      properties: { items: { items: ref('Comment') } },
    });
  });

  it('has them though no route uses them (no feature has a panel)', () => {
    expect(
      Object.keys(none.paths).filter((path) =>
        /\/\{id\}\/(comments|attachments|revisions|tags|documents)\b/.test(
          path,
        ),
      ),
    ).toEqual([]);
    for (const name of PANEL_COMPONENTS) {
      expect(none.components.schemas[name]).toBeDefined();
    }
  });

  it("types a record's PDF route: `?lang=` one of the shipped languages", () => {
    const lang = (
      full.paths['/v1/test-items/{id}/pdf']!.post.parameters as {
        name: string;
        in: string;
        schema: { enum?: string[] };
      }[]
    ).find((parameter) => parameter.name === 'lang');
    expect(lang).toMatchObject({ in: 'query', required: false });
    expect(lang!.schema.enum).toEqual(
      expect.arrayContaining(['en', 'de', 'ar', 'zh', 'ms', 'ar-AE']),
    );
  });

  it("has them exactly as a feature's routes emit them", () => {
    // addPanelComponents() converts them itself: it must not drift from
    // what @nestjs/swagger makes of the routes' schemas.
    for (const name of PANEL_COMPONENTS) {
      expect(none.components.schemas[name]).toEqual(
        full.components.schemas[name],
      );
    }
  });
});
