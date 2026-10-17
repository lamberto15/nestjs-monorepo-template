// What `--with …` adds to a generated feature (tools/feature/add.mjs): each
// capability is a platform module the feature opts into, as notes does,
// through a target class registered in the platform's registry and the
// record routes the platform builds (platform/records). templates.mjs splices
// the parts returned here into the files it writes; the targets are files of
// their own.
import { TYPES, pascalOf } from './fields.mjs';

export const CAPABILITIES = [
  'tags',
  'comments',
  'attachments',
  'revisions',
  'pdf',
  'bulk',
  'watch',
  'search',
  'transfer',
];

/** `--with tags,comments`: the capabilities, checked; pdf brings attachments (a PDF is one). */
export function parseCapabilities(list, fields) {
  const wanted = new Set(
    (list ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  for (const name of wanted) {
    if (!CAPABILITIES.includes(name)) {
      throw new Error(
        `--with: "${name}" is not a capability; any of ${CAPABILITIES.join(', ')}.`,
      );
    }
  }
  if (wanted.has('pdf')) {
    wanted.add('attachments');
  }
  if (wanted.has('search') && !textFields(fields).length) {
    throw new Error(
      '--with search: the feature needs a string or text field to search.',
    );
  }
  return wanted;
}

const textFields = (fields) =>
  fields.filter((f) => f.type === 'string' || f.type === 'text');
/** The field a record is called by (comments, search, PDF): its first string, if any. */
export const titleField = (fields) =>
  fields.find((f) => f.type === 'string') ?? null;
/** `invoiceLine`: notification types, i18n keys, audit actions. */
export const lowerFirst = (word) => word[0].toLowerCase() + word.slice(1);

/**
 * The parts each file gets from the capabilities: empty arrays when none
 * applies, so templates.mjs splices them without conditions of its own.
 */
export function parts({ t, fields, softDelete, capabilities: on }) {
  const S = t.Singular;
  const sc = t.singularCamel;
  const table = t.pluralCamel;
  const svc = t.pluralCamel;
  const has = (name) => on.has(name);
  const title = titleField(fields);
  const titleOf = (row) =>
    title ? `${row}.${title.name}` : `\`${pascalOf(t.noun)} \${${row}.id}\``;
  const bulkActions = ['delete', 'update', ...(softDelete ? ['restore'] : [])];
  return {
    tables: {
      imports: has('search')
        ? [
            `import { type SQL, sql } from 'drizzle-orm';`,
            `import { searchVector } from '../../core/database/search.js';`,
          ]
        : [],
      columns: has('search')
        ? [
            `    /** Full-text search over its text (core/database/search.ts): \`?q=\`, GET /v1/search. */`,
            `    search: searchVector('search', (): SQL => sql\`${textFields(
              fields,
            )
              .map((f) => `coalesce(\${${table}.${f.name}}, '')`)
              .join(" || ' ' || ")}\`),`,
          ]
        : [],
      indexes: has('search')
        ? [`    index('${t.table}_search_idx').using('gin', table.search),`]
        : [],
    },
    schemas: {
      imports: [
        ...(has('tags')
          ? [
              `import { tagRefSchema } from '../../platform/tags/tag.schemas.js';`,
            ]
          : []),
        ...(has('bulk')
          ? [
              `import { bulkRequestSchema } from '../../platform/bulk/bulk.schemas.js';`,
            ]
          : []),
      ],
      response: has('tags')
        ? [
            `  tags: z.array(tagRefSchema).describe('Its tags, by name (PUT /v1/${t.plural}/{id}/tags sets them).'),`,
          ]
        : [],
      exports: has('bulk')
        ? [
            '',
            `/** Body of \`POST /${t.plural}/bulk\`: an action on many (${t.singular}.bulk.ts). */`,
            `export const ${sc}BulkSchema = bulkRequestSchema(${JSON.stringify(bulkActions).replace(/"/g, "'")}, update${S}Schema);`,
          ]
        : [],
    },
    list: {
      imports: [
        ...(has('search')
          ? [`import { searchFields } from '../../core/database/search.js';`]
          : []),
        ...(has('tags')
          ? [`import { tagFilter } from '../../platform/tags/tag.list.js';`]
          : []),
      ],
      entries: [
        ...(has('search')
          ? [
              `    // ?q=words (web search syntax) and ?sort=-rank: the best match first.`,
              `    ...searchFields(${table}.search),`,
            ]
          : []),
        ...(has('tags')
          ? [
              `    // ?tag=<id> and ?tag.in=<id>,<id>: those carrying it.`,
              `    ...tagFilter('${S}', ${table}.id),`,
            ]
          : []),
      ],
    },
    service: {
      imports: [
        ...(has('revisions')
          ? [
              `import { RevisionsService } from '../../platform/revisions/revisions.service.js';`,
            ]
          : []),
        ...(has('watch')
          ? [
              `import { SubscriptionsService } from '../../platform/subscriptions/subscriptions.service.js';`,
            ]
          : []),
        ...(has('tags')
          ? [
              `import { TagsService } from '../../platform/tags/tags.service.js';`,
            ]
          : []),
      ],
      deps: [
        ...(has('revisions')
          ? [`    private readonly revisions: RevisionsService,`]
          : []),
        ...(has('watch')
          ? [`    private readonly subscriptions: SubscriptionsService,`]
          : []),
        ...(has('tags') ? [`    private readonly tags: TagsService,`] : []),
      ],
      afterCreate: [
        ...(has('watch')
          ? [
              `      // Its owner watches it: told of changes others make.`,
              `      await this.subscriptions.subscribe(owner, { subject: '${S}', recordId: row!.id });`,
            ]
          : []),
        ...(has('revisions')
          ? [
              `      // Revision 1: the first state, restorable like any later one.`,
              `      await this.revisions.record(tx, '${S}', row!.id, { snapshot: snapshot(row!), by });`,
            ]
          : []),
      ],
      afterUpdate: has('revisions')
        ? [
            `      await this.revisions.record(tx, '${S}', row.id, { snapshot: snapshot(updated!), before: snapshot(row), by, restoredFrom });`,
          ]
        : [],
      updateOptions: has('revisions'),
      hidden: has('search') ? ['search'] : [],
      methods: [
        `  /** Runs a read of your own on its table (exports, bulk actions, search). */`,
        `  query<T>(read: (db: Database) => Promise<T>) {`,
        `    return read(this.db);`,
        `  }`,
        ...(has('tags')
          ? [
              '',
              `  /** The rows with their tags (\`tags: [{ id, name, color }]\`): one query for them all. */`,
              `  async withTags<T extends { id: string }>(rows: T[]) {`,
              `    const tags = await this.tags.tagsOf('${S}', rows.map((row) => row.id));`,
              `    return rows.map((row) => ({ ...row, tags: tags.get(row.id) ?? [] }));`,
              `  }`,
            ]
          : []),
      ],
      functions: has('revisions')
        ? [
            '',
            `/** What its revisions keep: the fields a person changes, as the API shows them. */`,
            `export function snapshot(row: ${S}) {`,
            `  const shown = view(row);`,
            `  return { ${fields.map((f) => `${f.name}: shown.${f.name}`).join(', ')} };`,
            `}`,
          ]
        : [],
    },
    controller: {
      // With tags, a record is shown with its tags.
      present: has('tags')
        ? {
            list: (items) => `await this.${svc}.withTags(${items})`,
            one: (value) => `(await this.${svc}.withTags([${value}]))[0]!`,
          }
        : null,
    },
    module: {
      imports: [
        ...(has('tags') ||
        has('comments') ||
        has('attachments') ||
        has('revisions') ||
        has('pdf') ||
        has('bulk') ||
        has('watch')
          ? [
              `import { ${t.SINGULAR}_ROUTES } from './${t.singular}.routes.js';`,
            ]
          : []),
        ...(has('tags')
          ? [
              `import { tagRoutes } from '../../platform/tags/tag.routes.js';`,
              `import { ${S}Tags } from './${t.singular}-tags.js';`,
            ]
          : []),
        ...(has('comments')
          ? [
              `import { commentRoutes } from '../../platform/comments/comment.routes.js';`,
              `import { ${S}Comments } from './${t.singular}-comments.js';`,
            ]
          : []),
        ...(has('attachments')
          ? [
              `import { attachmentRoutes } from '../../platform/attachments/attachment.routes.js';`,
              `import { ${S}Attachments } from './${t.singular}-attachments.js';`,
            ]
          : []),
        ...(has('revisions')
          ? [
              `import { revisionRoutes } from '../../platform/revisions/revision.routes.js';`,
              `import { ${sc}Schema } from './${t.singular}.schemas.js';`,
              `import { ${S}Revisions } from './${t.singular}-revisions.js';`,
            ]
          : []),
        ...(has('pdf')
          ? [
              `import { documentRoutes } from '../../platform/documents/document.routes.js';`,
              `import { ${S}Documents } from './${t.singular}-documents.js';`,
            ]
          : []),
        ...(has('bulk')
          ? [
              `import { bulkRoutes } from '../../platform/bulk/bulk.routes.js';`,
              `import { ${sc}BulkSchema } from './${t.singular}.schemas.js';`,
              `import { ${S}Bulk } from './${t.singular}.bulk.js';`,
            ]
          : []),
        ...(has('watch')
          ? [
              `import { watchRoutes } from '../../platform/subscriptions/subscription.routes.js';`,
              `import { ${S}Subscriptions } from './${t.singular}-subscriptions.js';`,
            ]
          : []),
        ...(has('search')
          ? [`import { ${S}Search } from './${t.singular}.search.js';`]
          : []),
        ...(has('transfer')
          ? [`import { ${S}Transfer } from './${t.singular}.transfer.js';`]
          : []),
      ],
      // In notes' order: the routes' order is the OpenAPI document's.
      controllers: [
        ...(has('comments') ? [`commentRoutes(${t.SINGULAR}_ROUTES)`] : []),
        ...(has('attachments')
          ? [`attachmentRoutes(${t.SINGULAR}_ROUTES)`]
          : []),
        ...(has('tags') ? [`tagRoutes(${t.SINGULAR}_ROUTES)`] : []),
        ...(has('revisions')
          ? [`revisionRoutes(${t.SINGULAR}_ROUTES, { restored: ${sc}Schema })`]
          : []),
        ...(has('pdf')
          ? [
              `documentRoutes(${t.SINGULAR}_ROUTES, { source: '${lowerFirst(S)}' })`,
            ]
          : []),
        ...(has('bulk')
          ? [
              `bulkRoutes(${t.SINGULAR}_ROUTES, { name: '${t.plural}', body: ${sc}BulkSchema, docs: { summary: 'Act on many ${t.nouns} at once', description: 'Each one as its own route does it (permissions, audit); one that fails does not stop the others. Up to BULK_SYNC_LIMIT ids answer 200 with a result each; more, or a \`filter\`, answer 202: follow it at GET /v1/bulk/{id}.' } })`,
            ]
          : []),
        ...(has('watch') ? [`watchRoutes(${t.SINGULAR}_ROUTES)`] : []),
      ],
      providers: [
        ...(has('tags') ? [`${S}Tags`] : []),
        ...(has('comments') ? [`${S}Comments`] : []),
        ...(has('attachments') ? [`${S}Attachments`] : []),
        ...(has('revisions') ? [`${S}Revisions`] : []),
        ...(has('pdf') ? [`${S}Documents`] : []),
        ...(has('bulk') ? [`${S}Bulk`] : []),
        ...(has('watch') ? [`${S}Subscriptions`] : []),
        ...(has('search') ? [`${S}Search`] : []),
        ...(has('transfer') ? [`${S}Transfer`] : []),
      ],
    },
    feature: {
      imports: has('comments')
        ? [
            `import { ${t.SINGULAR}_NOTIFICATIONS } from './${t.singular}-notifications.js';`,
          ]
        : [],
      entries: has('comments')
        ? [`  notifications: ${t.SINGULAR}_NOTIFICATIONS,`]
        : [],
    },
    e2e: e2eTests({
      t,
      fields,
      softDelete,
      has,
      path: `/v1/${t.plural}`,
      title,
    }),
    files: targetFiles({
      t,
      fields,
      softDelete,
      has,
      title,
      titleOf,
      bulkActions,
    }),
    texts: texts({ t, fields, has, title }),
  };
}

/** The tests each capability adds to the generated e2e spec. */
function e2eTests({ t, has, path, title }) {
  const tests = [];
  const make = `const id = (await create(node.admin()).expect(201)).body.id as string;`;
  if (has('tags')) {
    tests.push(
      `  it('takes tags, and lists by them', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    const tag = (await admin.post('/v1/tags').send({ subject: '${t.Singular}', name: 'Urgent' }).expect(201)).body.id as string;`,
      `    await admin.put(\`${path}/\${id}/tags\`).send({ tagIds: [tag] }).expect(200);`,
      `    expect((await admin.get(\`${path}/\${id}\`).expect(200)).body.tags).toEqual([expect.objectContaining({ id: tag })]);`,
      `    expect((await admin.get(\`${path}?tag=\${tag}\`).expect(200)).body.items.map((item: { id: string }) => item.id)).toEqual([id]);`,
      `  });`,
    );
  }
  if (has('comments')) {
    tests.push(
      `  it('takes comments', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    await admin.post(\`${path}/\${id}/comments\`).send({ body: 'Looks good.' }).expect(201);`,
      `    expect((await admin.get(\`${path}/\${id}/comments\`).expect(200)).body.items).toHaveLength(1);`,
      `  });`,
    );
  }
  if (has('attachments')) {
    tests.push(
      `  it('takes attachments', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    await admin.post(\`${path}/\${id}/attachments\`).attach('file', Buffer.from('Minutes.\\n'), { filename: 'minutes.txt', contentType: 'text/plain' }).expect(201);`,
      `    expect((await admin.get(\`${path}/\${id}/attachments\`).expect(200)).body.items).toHaveLength(1);`,
      `  });`,
    );
  }
  if (has('revisions')) {
    tests.push(
      `  it('keeps its revisions', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    await admin.patch(\`${path}/\${id}\`).send(changed).expect(200);`,
      `    const revisions = (await admin.get(\`${path}/\${id}/revisions\`).expect(200)).body.items;`,
      `    expect(revisions).toHaveLength(2);`,
      `    await admin.post(\`${path}/\${id}/revisions/1/restore\`).expect(200);`,
      `  });`,
    );
  }
  if (has('pdf')) {
    tests.push(
      `  it('asks for a PDF (unavailable without Gotenberg: GOTENBERG_URL)', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    const res = await admin.post(\`${path}/\${id}/pdf\`).set('Idempotency-Key', randomUUID()).expect(503);`,
      `    expect(res.body.code).toBe('documents_unavailable');`,
      `  });`,
    );
  }
  if (has('bulk')) {
    tests.push(
      `  it('deletes many at once', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    const res = await admin.post('${path}/bulk').set('Idempotency-Key', randomUUID()).send({ action: 'delete', ids: [id] }).expect(200);`,
      `    expect(res.body.done).toBe(1);`,
      `    await admin.get(\`${path}/\${id}\`).expect(404);`,
      `  });`,
    );
  }
  if (has('watch')) {
    tests.push(
      `  it('is watched, and unwatched', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    expect((await admin.post(\`${path}/\${id}/watch\`).expect(200)).body).toEqual({ watching: true });`,
      `    await admin.delete(\`${path}/\${id}/watch\`).expect(204);`,
      `  });`,
    );
  }
  if (has('search') && title) {
    tests.push(
      `  it('is found by its words', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    const found = (await admin.get('${path}?q=${title.name}').expect(200)).body.items.map((item: { id: string }) => item.id);`,
      `    expect(found).toContain(id);`,
      `  });`,
    );
  }
  return tests;
}

/** The target files: each implements its registry's interface, as notes' do. */
function targetFiles({
  t,
  fields,
  softDelete,
  has,
  title,
  titleOf,
  bulkActions,
}) {
  const S = t.Singular;
  const svc = t.pluralCamel;
  const table = t.pluralCamel;
  const files = {};
  const header = (iface, registry, from) => [
    `import { Injectable } from '@nestjs/common';`,
    `import type { Principal } from '../../iam/auth/principal.js';`,
    `import { type ${iface}, ${registry} } from '../../platform/${from}';`,
    `import { ${S}Policy } from './${t.singular}.policy.js';`,
    `import { ${t.Plural}Service } from './${t.plural}.service.js';`,
    '',
  ];
  const ctor = (extra = []) => [
    `  constructor(`,
    `    private readonly ${svc}: ${t.Plural}Service,`,
    `    private readonly policy: ${S}Policy,`,
    ...extra,
    `    registry: REGISTRY,`,
    `  ) {`,
    `    registry.register(this);`,
    `  }`,
  ];
  if (has('tags')) {
    files[`${t.singular}-tags.ts`] = [
      ...header('TagTarget', 'TagsRegistry', 'tags/tags.registry.js'),
      `/** ${pascalOf(t.nouns)} carry tags (platform/tags): whoever may change one (\`${S}.update\`) sets its tags. */`,
      `@Injectable()`,
      `export class ${S}Tags implements TagTarget {`,
      `  readonly subject = '${S}';`,
      '',
      ...ctor().map((line) => line.replace('REGISTRY', 'TagsRegistry')),
      '',
      `  /** A 404 when it doesn't exist${softDelete ? ' (or is in the recycle bin)' : ''}. */`,
      `  async canTag(principal: Principal, id: string) {`,
      `    return this.policy.update(principal, await this.${svc}.findOne(id));`,
      `  }`,
      `}`,
    ].join('\n');
  }
  if (has('comments')) {
    files[`${t.singular}-comments.ts`] = [
      ...header(
        'CommentTarget',
        'CommentsRegistry',
        'comments/comments.registry.js',
      ),
      `/**`,
      ` * ${pascalOf(t.nouns)} take comments (platform/comments): whoever may read one reads and writes`,
      ` * its comments; whoever may change it (\`${S}.update\`) moderates them. Watchers hear \`${lowerFirst(S)}.commented\`.`,
      ` */`,
      `@Injectable()`,
      `export class ${S}Comments implements CommentTarget {`,
      `  readonly subject = '${S}';`,
      `  readonly commentedType = '${lowerFirst(S)}.commented';`,
      '',
      ...ctor().map((line) => line.replace('REGISTRY', 'CommentsRegistry')),
      '',
      `  async canRead(principal: Principal, id: string) {`,
      `    return this.policy.read(principal, await this.${svc}.findOne(id));`,
      `  }`,
      '',
      `  async canModerate(principal: Principal, id: string) {`,
      `    return this.policy.update(principal, await this.${svc}.findOne(id));`,
      `  }`,
      '',
      `  link(id: string) {`,
      `    return \`/${t.plural}/\${id}\`;`,
      `  }`,
      '',
      `  async title(id: string) {`,
      `    const row = await this.${svc}.findOne(id);`,
      `    return ${titleOf('row')};`,
      `  }`,
      `}`,
    ].join('\n');
    files[`${t.singular}-notifications.ts`] = [
      `import { commentedData } from '../../platform/comments/comment-notifications.js';`,
      `import { defineNotifications } from '../../platform/notifications/notification.types.js';`,
      '',
      `/** What ${t.nouns}' people are told of (texts: \`i18n/<locale>/notifications.json\`, under \`${lowerFirst(S)}\`). */`,
      `export const ${t.SINGULAR}_NOTIFICATIONS = defineNotifications([`,
      `  {`,
      `    // Someone else commented on one they watch (platform/comments): bundled daily by default.`,
      `    type: '${lowerFirst(S)}.commented',`,
      `    channels: { email: 'daily', webhook: true },`,
      `    data: commentedData,`,
      `  },`,
      `]);`,
    ].join('\n');
  }
  if (has('attachments')) {
    files[`${t.singular}-attachments.ts`] = [
      `import { Injectable, NotFoundException } from '@nestjs/common';`,
      `import { inArray } from 'drizzle-orm';`,
      `import { AccessService } from '../../iam/access/access.service.js';`,
      `import type { Principal } from '../../iam/auth/principal.js';`,
      `import { type AttachmentTarget, AttachmentsRegistry } from '../../platform/attachments/attachments.registry.js';`,
      `import { ${S}Policy } from './${t.singular}.policy.js';`,
      `import type { ${S} } from './${t.singular}.schemas.js';`,
      `import { ${t.Plural}Service } from './${t.plural}.service.js';`,
      `import { ${table} } from './${t.plural}.tables.js';`,
      '',
      `/** ${pascalOf(t.nouns)} take attachments: whoever may read one sees them, whoever may change it adds and removes them. */`,
      `@Injectable()`,
      `export class ${S}Attachments implements AttachmentTarget {`,
      `  readonly subject = '${S}';`,
      '',
      `  constructor(`,
      `    private readonly ${svc}: ${t.Plural}Service,`,
      `    private readonly policy: ${S}Policy,`,
      `    private readonly access: AccessService,`,
      `    registry: AttachmentsRegistry,`,
      `  ) {`,
      `    registry.register(this);`,
      `  }`,
      '',
      `  async canRead(principal: Principal, id: string) {`,
      `    const row = await this.find(id);`,
      `    return row !== null && this.policy.read(principal, row);`,
      `  }`,
      '',
      `  async canWrite(principal: Principal, id: string) {`,
      `    const row = await this.find(id);`,
      `    return row !== null && this.policy.update(principal, row);`,
      `  }`,
      '',
      `  /** Every one of these fields, as reading it would show them (an issued PDF's). */`,
      `  async canReadFields(principal: Principal, id: string, fields: readonly string[]) {`,
      `    const row = await this.find(id);`,
      `    if (!row || !(await this.policy.read(principal, row))) return false;`,
      `    const shown = await this.access.redact(principal, 'read', '${S}', row);`,
      `    return fields.every((field) => field in shown);`,
      `  }`,
      '',
      `  async exists(ids: readonly string[]) {`,
      `    const rows = await this.${svc}.query((db) => db.select({ id: ${table}.id }).from(${table}).where(inArray(${table}.id, [...ids])));`,
      `    return rows.map((row) => row.id);`,
      `  }`,
      '',
      `  private async find(id: string): Promise<${S} | null> {`,
      `    try {`,
      `      return await this.${svc}.findOne(id);`,
      `    } catch (error) {`,
      `      if (error instanceof NotFoundException) return null;`,
      `      throw error;`,
      `    }`,
      `  }`,
      `}`,
    ].join('\n');
  }
  if (has('revisions')) {
    files[`${t.singular}-revisions.ts`] = [
      `import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';`,
      `import { validationException } from '../../core/http/problem-details.filter.js';`,
      `import { AccessService } from '../../iam/access/access.service.js';`,
      `import type { Principal } from '../../iam/auth/principal.js';`,
      `import { type RevisionItem, type RevisionTarget, RevisionsRegistry } from '../../platform/revisions/revisions.registry.js';`,
      `import { ${S}Policy } from './${t.singular}.policy.js';`,
      `import { type ${S}, update${S}Schema } from './${t.singular}.schemas.js';`,
      `import { ${t.Plural}Service, snapshot, view } from './${t.plural}.service.js';`,
      '',
      `/**`,
      ` * ${pascalOf(t.nouns)} keep their revisions (platform/revisions): their fields after each change.`,
      ` * Whoever may read one reads them; whoever may change it restores one, through`,
      ` * ${t.Plural}Service.update (the PATCH's checks, audited, a new revision).`,
      ` */`,
      `@Injectable()`,
      `export class ${S}Revisions implements RevisionTarget {`,
      `  readonly subject = '${S}';`,
      '',
      `  constructor(`,
      `    private readonly ${svc}: ${t.Plural}Service,`,
      `    private readonly policy: ${S}Policy,`,
      `    private readonly access: AccessService,`,
      `    registry: RevisionsRegistry,`,
      `  ) {`,
      `    registry.register(this);`,
      `  }`,
      '',
      `  async canRead(principal: Principal, id: string) {`,
      `    const row = await this.find(id);`,
      `    return row !== null && this.policy.read(principal, row);`,
      `  }`,
      '',
      `  async canRestore(principal: Principal, id: string) {`,
      `    const row = await this.find(id);`,
      `    return row !== null && this.policy.update(principal, row);`,
      `  }`,
      '',
      `  snapshot(row: ${S}) {`,
      `    return snapshot(row);`,
      `  }`,
      '',
      `  /** Changes what differs from the snapshot, with a PATCH's checks (its schema, field-level). */`,
      `  async apply(principal: Principal, id: string, fields: Record<string, unknown>, { ip, restoredFrom }: { ip?: string; restoredFrom: number }) {`,
      `    const row = await this.${svc}.findOne(id);`,
      `    const now = snapshot(row) as Record<string, unknown>;`,
      `    const changes = Object.fromEntries(Object.entries(fields).filter(([field, value]) => field in now && JSON.stringify(value) !== JSON.stringify(now[field])));`,
      `    const parsed = update${S}Schema.safeParse(changes);`,
      `    if (!parsed.success) {`,
      `      throw validationException(parsed.error.issues);`,
      `    }`,
      `    const forbidden = await this.access.forbiddenFields(principal, 'update', '${S}', parsed.data, row);`,
      `    if (forbidden.length) {`,
      `      throw new ForbiddenException({ code: 'field_forbidden', message: \`You may not change: \${forbidden.join(', ')}.\`, fields: forbidden });`,
      `    }`,
      `    const updated = await this.${svc}.update(principal, row, parsed.data, ip, { restoredFrom });`,
      `    return this.access.redact(principal, 'read', '${S}', view(updated));`,
      `  }`,
      '',
      `  async shown(principal: Principal, id: string) {`,
      `    return this.access.redact(principal, 'read', '${S}', view(await this.${svc}.findOne(id)));`,
      `  }`,
      '',
      `  /** Without the fields the reader's permissions leave out, in the snapshots and in the changes. */`,
      `  async redact(principal: Principal, id: string, items: RevisionItem[]): Promise<RevisionItem[]> {`,
      `    const row = view(await this.${svc}.findOne(id));`,
      `    return Promise.all(`,
      `      items.map(async ({ snapshot: kept, changes }) => {`,
      `        const allowed = await this.access.redact(principal, 'read', '${S}', { ...row, ...kept } as Record<string, unknown>);`,
      `        const shown = Object.fromEntries(Object.entries(kept).filter(([field]) => field in allowed));`,
      `        return {`,
      `          snapshot: shown,`,
      `          changes: changes && Object.fromEntries(Object.entries(changes).filter(([key]) => key.split('.', 1)[0]! in shown)),`,
      `        };`,
      `      }),`,
      `    );`,
      `  }`,
      '',
      `  private async find(id: string): Promise<${S} | null> {`,
      `    try {`,
      `      return await this.${svc}.findOne(id);`,
      `    } catch (error) {`,
      `      if (error instanceof NotFoundException) return null;`,
      `      throw error;`,
      `    }`,
      `  }`,
      `}`,
    ].join('\n');
  }
  if (has('pdf')) {
    const lc = lowerFirst(S);
    files[`${t.singular}-documents.ts`] = [
      `import { Injectable, NotFoundException } from '@nestjs/common';`,
      `import { I18nService } from '@nestjs/i18n';`,
      `import { AccessService } from '../../iam/access/access.service.js';`,
      `import type { RequestPrincipal } from '../../iam/auth/principal.js';`,
      `import { type DocumentRenderOptions, type DocumentSource, DocumentsRegistry } from '../../platform/documents/documents.registry.js';`,
      `import { ${S}Policy } from './${t.singular}.policy.js';`,
      `import { ${t.Plural}Service, view } from './${t.plural}.service.js';`,
      '',
      `/** The fields its PDF shows, in this order (labels: \`i18n/<locale>/documents.json\`, \`${lc}.fields\`). */`,
      `const FIELDS = ${JSON.stringify(fields.filter((f) => f.type !== 'json').map((f) => f.name)).replace(/"/g, "'")} as const;`,
      '',
      `/**`,
      ` * ${pascalOf(t.aNoun)} as a PDF (platform/documents): its fields, in the requester's language and`,
      ` * time zone. Whoever may read it asks for one (POST /v1/${t.plural}/{id}/pdf); it becomes one of its`,
      ` * attachments. Only the fields the requester may read are in it (\`fields\`).`,
      ` */`,
      `@Injectable()`,
      `export class ${S}Documents implements DocumentSource {`,
      `  readonly name = '${lc}';`,
      `  readonly subject = '${S}';`,
      '',
      `  constructor(`,
      `    private readonly ${svc}: ${t.Plural}Service,`,
      `    private readonly policy: ${S}Policy,`,
      `    private readonly access: AccessService,`,
      `    private readonly i18n: I18nService,`,
      `    registry: DocumentsRegistry,`,
      `  ) {`,
      `    registry.register(this);`,
      `  }`,
      '',
      `  /** Whoever may read it (DocumentsService checked that already). */`,
      `  canIssue() {`,
      `    return Promise.resolve(true);`,
      `  }`,
      '',
      `  async content(principal: RequestPrincipal, id: string, { locale, timezone, issuedAt }: DocumentRenderOptions) {`,
      `    const row = await this.${svc}.findOne(id);`,
      `    if (!(await this.policy.read(principal, row))) {`,
      `      throw new NotFoundException(\`${pascalOf(t.noun)} \${id} not found.\`);`,
      `    }`,
      `    const shown = (await this.access.redact(principal, 'read', '${S}', view(row))) as Record<string, unknown>;`,
      `    const label = (key: string, args?: Record<string, string>) => this.i18n.translate(\`documents.${lc}.\${key}\`, { locale, args });`,
      `    const date = (value: Date) => this.i18n.formatDate(value, { locale, dateStyle: 'long', timeStyle: 'short', timeZone: timezone });`,
      `    const text = (value: unknown) => value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value as string | number | boolean);`,
      `    const fields = FIELDS.filter((field) => field in shown);`,
      `    return {`,
      `      template: '${t.singular}',`,
      `      fields,`,
      `      title: ${title ? `String(row.${title.name})` : `\`${pascalOf(t.noun)} \${row.id}\``},`,
      `      fileName: \`${t.singular}-\${row.id}\`,`,
      `      context: {`,
      `        labels: { document: label('document'), issued: label('issued', { date: date(issuedAt) }) },`,
      `        title: ${title ? `String(row.${title.name})` : `label('document')`},`,
      `        rows: fields.map((field) => ({ label: label(\`fields.\${field}\`), value: text(shown[field]) })),`,
      `      },`,
      `    };`,
      `  }`,
      `}`,
    ].join('\n');
  }
  if (has('bulk')) {
    files[`${t.singular}.bulk.ts`] = [
      `import { ForbiddenException, Injectable } from '@nestjs/common';`,
      `import { and, desc, inArray, lt } from 'drizzle-orm';`,
      `import type { ListQuery } from '../../core/http/list-query.js';`,
      `import { AccessService } from '../../iam/access/access.service.js';`,
      `import type { Principal } from '../../iam/auth/principal.js';`,
      `import { BulkRegistry } from '../../platform/bulk/bulk.registry.js';`,
      `import type { BulkOperation, BulkSelection } from '../../platform/bulk/bulk.types.js';`,
      `import { ${t.SINGULAR}_LIST } from './${t.singular}.list.js';`,
      `import { type ${S}, update${S}Schema, type Update${S}Dto } from './${t.singular}.schemas.js';`,
      `import { ${t.Plural}Service } from './${t.plural}.service.js';`,
      `import { ${table} } from './${t.plural}.tables.js';`,
      '',
      `/** Acted on this many at a time. */`,
      `const BATCH = 500;`,
      '',
      `/**`,
      ` * POST /${t.plural}/bulk: ${bulkActions.join(', ')} many, each as its own route would`,
      ` * (${t.Plural}Service: its transaction, its audit entry). The selection: those the caller may`,
      ` * act on (the list's SQL filter for that permission), among the ids or matching the list's filters.`,
      ` */`,
      `@Injectable()`,
      `export class ${S}Bulk implements BulkOperation<${S}> {`,
      `  readonly name = '${t.plural}';`,
      `  readonly subject = '${S}';`,
      `  readonly actions = {`,
      `    delete: { label: 'Delete${softDelete ? ' (to the recycle bin)' : ''}', permission: 'delete' },`,
      ...(softDelete
        ? [
            `    restore: { label: 'Restore from the recycle bin', permission: 'restore' },`,
          ]
        : []),
      `    update: { label: 'Change', permission: 'update', input: update${S}Schema },`,
      `  };`,
      `  readonly filters = ${t.SINGULAR}_LIST.schema;`,
      '',
      `  constructor(`,
      `    private readonly ${svc}: ${t.Plural}Service,`,
      `    private readonly access: AccessService,`,
      `    registry: BulkRegistry,`,
      `  ) {`,
      `    registry.register(this);`,
      `  }`,
      '',
      `  async *select(principal: Principal, action: string, selection: BulkSelection) {`,
      `    const where = and(`,
      softDelete
        ? `      await this.access.sqlFilter(principal, '${S}', action, { deleted: action === 'restore' }),`
        : `      await this.access.sqlFilter(principal, '${S}', action),`,
      `      selection.ids ? inArray(${table}.id, selection.ids) : ${t.SINGULAR}_LIST.where(selection.filter as ListQuery),`,
      `    );`,
      `    let cursor: string | undefined;`,
      `    for (;;) {`,
      `      const rows = await this.${svc}.query((db) => db.select().from(${table}).where(and(where, cursor ? lt(${table}.id, cursor) : undefined)).orderBy(desc(${table}.id)).limit(BATCH));`,
      `      if (rows.length === 0) {`,
      `        return;`,
      `      }`,
      `      yield rows;`,
      `      cursor = rows[rows.length - 1]!.id;`,
      `    }`,
      `  }`,
      '',
      `  async perform(principal: Principal, action: string, selected: ${S}, input: unknown, ip?: string) {`,
      `    // As it is now, not as it was selected (a 404 or 403 fails this item alone).`,
      softDelete
        ? `    const row = await this.${svc}.findOne(selected.id, undefined, { deleted: action === 'restore' });`
        : `    const row = await this.${svc}.findOne(selected.id);`,
      `    if (!(await this.access.can(principal, action, '${S}', row))) {`,
      `      throw new ForbiddenException();`,
      `    }`,
      `    if (action === 'delete') {`,
      `      await this.${svc}.delete(principal, row, ip);`,
      ...(softDelete
        ? [
            `    } else if (action === 'restore') {`,
            `      await this.${svc}.restore(principal, row, ip);`,
          ]
        : []),
      `    } else {`,
      `      const dto = input as Update${S}Dto;`,
      `      const forbidden = await this.access.forbiddenFields(principal, 'update', '${S}', dto, row);`,
      `      if (forbidden.length) {`,
      `        throw new ForbiddenException({ code: 'field_forbidden', message: \`You may not change: \${forbidden.join(', ')}.\`, fields: forbidden });`,
      `      }`,
      `      await this.${svc}.update(principal, row, dto, ip);`,
      `    }`,
      `  }`,
      `}`,
    ].join('\n');
  }
  if (has('watch')) {
    files[`${t.singular}-subscriptions.ts`] = [
      `import { Injectable } from '@nestjs/common';`,
      `import { AuthorizationService } from '@nestjs/authorization';`,
      `import type { Principal } from '../../iam/auth/principal.js';`,
      `import { type SubscriptionTarget, SubscriptionsRegistry } from '../../platform/subscriptions/subscriptions.registry.js';`,
      `import { ${S}Policy } from './${t.singular}.policy.js';`,
      `import { ${t.Plural}Service } from './${t.plural}.service.js';`,
      '',
      `/** Watching ${t.nouns} (POST /v1/${t.plural}/{id}/watch): whoever may read one. */`,
      `@Injectable()`,
      `export class ${S}Subscriptions implements SubscriptionTarget {`,
      `  readonly subject = '${S}';`,
      '',
      `  constructor(`,
      `    private readonly ${svc}: ${t.Plural}Service,`,
      `    private readonly authorization: AuthorizationService,`,
      `    registry: SubscriptionsRegistry,`,
      `  ) {`,
      `    registry.register(this);`,
      `  }`,
      '',
      `  async assertCanWatch(principal: Principal, recordId: string) {`,
      `    const row = await this.${svc}.findOne(recordId);`,
      `    await this.authorization.authorize(${S}Policy, 'read', principal, row);`,
      `  }`,
      `}`,
    ].join('\n');
  }
  if (has('search')) {
    const texts = fields.filter(
      (f) => f.type === 'string' || f.type === 'text',
    );
    const name = title ?? texts[0];
    files[`${t.singular}.search.ts`] = [
      `import { Injectable } from '@nestjs/common';`,
      `import { and, desc, getTableColumns } from 'drizzle-orm';`,
      `import { headline, matches, rank } from '../../core/database/search.js';`,
      `import { AccessService } from '../../iam/access/access.service.js';`,
      `import type { Principal } from '../../iam/auth/principal.js';`,
      `import { type SearchHit, SearchRegistry, type SearchSource } from '../../platform/search/search.registry.js';`,
      `import { ${t.Plural}Service } from './${t.plural}.service.js';`,
      `import { ${table} } from './${t.plural}.tables.js';`,
      '',
      `/** ${pascalOf(t.nouns)} in the global search (GET /v1/search): those the principal may read, best match first. */`,
      `@Injectable()`,
      `export class ${S}Search implements SearchSource {`,
      `  readonly subject = '${S}';`,
      '',
      `  constructor(`,
      `    private readonly ${svc}: ${t.Plural}Service,`,
      `    private readonly access: AccessService,`,
      `    registry: SearchRegistry,`,
      `  ) {`,
      `    registry.register(this);`,
      `  }`,
      '',
      `  async search(principal: Principal, q: string, limit: number): Promise<SearchHit[]> {`,
      `    const where = and(await this.access.sqlFilter(principal, '${S}', 'read'), matches(${table}.search, q));`,
      `    const score = rank(${table}.search, q);`,
      `    const rows = await this.${svc}.query((db) =>`,
      `      db`,
      `        // The whole row: the permission conditions (\`mine\`) read it.`,
      `        .select({ ...getTableColumns(${table}), score, snippet: headline(${table}.${name.name}, q) })`,
      `        .from(${table})`,
      `        .where(where)`,
      `        .orderBy(desc(score), desc(${table}.id))`,
      `        .limit(limit),`,
      `    );`,
      `    const shown = await this.access.redactAll(principal, 'read', '${S}', rows);`,
      `    return shown.map((row) => ({`,
      `      subject: '${S}',`,
      `      id: row.id!,`,
      `      title: String(row.${name.name} ?? row.id),`,
      `      snippet: (row.snippet as string | null) ?? null,`,
      `      score: Number(row.score),`,
      `      link: \`/${t.plural}/\${row.id}\`,`,
      `    }));`,
      `  }`,
      `}`,
    ].join('\n');
  }
  if (has('transfer')) {
    // Columns a spreadsheet holds as they are: the rest export as text, and
    // the importer leaves them out (they come from the API).
    const flat = fields.filter((f) => !['money', 'json'].includes(f.type));
    const required = fields.filter(
      (f) => !f.optional && ['money', 'json'].includes(f.type),
    );
    const importable = required.length === 0;
    files[`${t.singular}.transfer.ts`] = [
      `import { Injectable } from '@nestjs/common';`,
      `import { and, desc, eq, lt } from 'drizzle-orm';`,
      ...(importable ? [`import { z } from 'zod';`] : []),
      `import { AccessService } from '../../iam/access/access.service.js';`,
      `import { type Principal, principalKey, type UserPrincipal } from '../../iam/auth/principal.js';`,
      `import { type PersonalDataSource, PersonalDataRegistry } from '../../platform/account/personal-data.registry.js';`,
      `import { DataTransferRegistry } from '../../platform/data-transfer/data-transfer.registry.js';`,
      `import type { DataExporter, ${importable ? 'DataImporter, ' : ''}TransferColumn } from '../../platform/data-transfer/data-transfer.types.js';`,
      `import { ${t.SINGULAR}_LIST } from './${t.singular}.list.js';`,
      `import { ${importable ? `create${S}Schema, ` : ''}type ${S} } from './${t.singular}.schemas.js';`,
      `import { ${t.Plural}Service, view } from './${t.plural}.service.js';`,
      `import { ${table} } from './${t.plural}.tables.js';`,
      '',
      ...(importable
        ? [
            `/** A row: POST /${t.plural}'s own schema${flat.length < fields.length ? ', without the fields a spreadsheet cell can’t hold' : ''}. */`,
            `const ${t.singularCamel}Row = create${S}Schema${
              flat.length < fields.length
                ? `.omit({ ${fields
                    .filter((f) => !flat.includes(f))
                    .map((f) => `${f.name}: true`)
                    .join(', ')} })`
                : ''
            };`,
            `type ${S}Row = z.infer<typeof ${t.singularCamel}Row>;`,
            '',
          ]
        : []),
      `/**`,
      ` * ${pascalOf(t.nouns)} as CSV, JSON or Excel (platform/data-transfer): the export holds those the`,
      ` * principal may read${importable ? `; the import makes one per row through ${t.Plural}Service.create` : ''}. A user's own are part of`,
      ` * their data export (POST /v1/account/export).`,
      ` */`,
      `@Injectable()`,
      `export class ${S}Transfer implements DataExporter<${S}>, ${importable ? `DataImporter<${S}Row>, ` : ''}PersonalDataSource {`,
      `  readonly name = '${t.plural}';`,
      `  readonly subject = '${S}';`,
      `  readonly columns: readonly TransferColumn[] = [`,
      `    { key: 'id' },`,
      ...fields.map((f) =>
        f.type === 'money'
          ? `    { key: '${f.name}', value: (row) => { const money = view(row as ${S}).${f.name}; return money ? \`\${money.amount} \${money.currency}\` : ''; } },`
          : f.type === 'json'
            ? `    { key: '${f.name}', value: (row) => JSON.stringify(row.${f.name} ?? null) },`
            : f.type === 'datetime'
              ? `    { key: '${f.name}', type: 'datetime' },`
              : `    { key: '${f.name}' },`,
      ),
      `    { key: 'ownerId', header: 'owner' },`,
      `    { key: 'createdAt', type: 'datetime' },`,
      `  ];`,
      `  readonly filters = ${t.SINGULAR}_LIST.schema;`,
      ...(importable
        ? [`  readonly schema: z.ZodType<${S}Row> = ${t.singularCamel}Row;`]
        : []),
      '',
      `  constructor(`,
      `    private readonly ${svc}: ${t.Plural}Service,`,
      `    private readonly access: AccessService,`,
      `    registry: DataTransferRegistry,`,
      `    personalData: PersonalDataRegistry,`,
      `  ) {`,
      `    registry.registerExporter(this);`,
      ...(importable ? [`    registry.registerImporter(this);`] : []),
      `    personalData.register(this);`,
      `  }`,
      '',
      `  /** A person's data export: those they own (they stay when the account is deleted). */`,
      `  async *rows(user: UserPrincipal) {`,
      `    let cursor: string | undefined;`,
      `    for (;;) {`,
      `      const rows = await this.${svc}.query((db) => db.select().from(${table}).where(and(eq(${table}.ownerId, principalKey(user)), cursor ? lt(${table}.id, cursor) : undefined)).orderBy(desc(${table}.id)).limit(1000));`,
      `      if (rows.length === 0) return;`,
      `      yield rows.map(view) as Record<string, unknown>[];`,
      `      cursor = rows[rows.length - 1]!.id;`,
      `    }`,
      `  }`,
      '',
      `  async *batches(principal: Principal, filters: Record<string, unknown>) {`,
      `    const where = and(await this.access.sqlFilter(principal, '${S}', 'read'), ${t.SINGULAR}_LIST.where({ limit: 1000, ...filters }));`,
      `    let cursor: string | undefined;`,
      `    for (;;) {`,
      `      const rows = await this.${svc}.query((db) => db.select().from(${table}).where(and(where, cursor ? lt(${table}.id, cursor) : undefined)).orderBy(desc(${table}.id)).limit(1000));`,
      `      if (rows.length === 0) {`,
      `        return;`,
      `      }`,
      `      yield rows;`,
      `      cursor = rows[rows.length - 1]!.id;`,
      `    }`,
      `  }`,
      ...(importable
        ? [
            '',
            `  /** One row, as POST /${t.plural} writes it (the platform checked its fields). */`,
            `  async write(principal: Principal, row: ${S}Row) {`,
            `    await this.${svc}.create(principal, row);`,
            `  }`,
          ]
        : []),
      `}`,
    ].join('\n');
  }
  return files;
}

/**
 * The texts the capabilities need, by namespace and key path (English; the
 * other locales get the same until translated: add.mjs lists them).
 */
function texts({ t, fields, has }) {
  const lc = lowerFirst(t.Singular);
  const out = {};
  if (has('comments')) {
    out.notifications = {
      [lc]: {
        commented: {
          label: `Comment on ${t.aNoun} you watch`,
          title: 'New comment',
          body: {
            one: '{by} commented on "{title}": {excerpt}',
            other:
              '{count} new comments on "{title}"; the latest by {by}: {excerpt}',
          },
        },
      },
    };
  }
  if (has('pdf')) {
    out.documents = {
      [lc]: {
        document: pascalOf(t.noun),
        issued: 'Issued {date}',
        fields: Object.fromEntries(
          fields
            .filter((f) => f.type !== 'json')
            .map((f) => [f.name, words(f.name)]),
        ),
      },
    };
  }
  return out;
}

/** `dueOn` → `Due on`: a label. */
const words = (camelName) => {
  const spaced = camelName.replace(
    /[A-Z]/g,
    (letter) => ` ${letter.toLowerCase()}`,
  );
  return spaced[0].toUpperCase() + spaced.slice(1);
};

/** The PDF's page (apps/api/src/documents/templates/<x>.html): its rows as label and value. */
export const documentTemplate = () =>
  [
    '<header>',
    '  <p class="eyebrow">{{ labels.document }}</p>',
    '  <h1>{{ title }}</h1>',
    '</header>',
    '<table class="facts">',
    '  {{#each rows}}',
    '  <tr>',
    '    <th>{{ this.label }}</th>',
    '    <td>{{ this.value }}</td>',
    '  </tr>',
    '  {{/each}}',
    '</table>',
    '<footer>{{ labels.issued }}</footer>',
    '',
  ].join('\n');

export { TYPES };
