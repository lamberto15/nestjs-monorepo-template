import type { Provider, Type } from '@nestjs/common';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { attachmentRoutes } from '../attachments/attachment.routes.js';
import { bulkRoutes } from '../bulk/bulk.routes.js';
import { commentRoutes } from '../comments/comment.routes.js';
import { documentRoutes } from '../documents/document.routes.js';
import { revisionRoutes } from '../revisions/revision.routes.js';
import { watchRoutes } from '../subscriptions/subscription.routes.js';
import { listSource } from '../lists/lists.registry.js';
import { tagRoutes } from '../tags/tag.routes.js';
import { type Capability, type RecordDeclaration, takes } from './record.js';
import {
  RECORD_CONTRACT,
  RECORD_DECLARATION,
  RECORD_POLICY,
  RECORD_TABLE,
  type RecordContract,
  RecordLifecycle,
  RecordPresenter,
} from './record-contract.js';
import type { RecordList } from './record-list.js';
import { restoreRoutes } from './record-restore.routes.js';
import { RecordStore } from './record-store.js';
import type { RecordSchemas } from './record.schemas.js';
import {
  recordKey,
  RecordAttachments,
  RecordBulk,
  RecordComments,
  RecordDocuments,
  RecordRevisions,
  RecordSearch,
  RecordSubscriptions,
  RecordTags,
  RecordTransfer,
} from './record-targets.js';

/**
 * The generic target of each capability that has one (record-targets.ts);
 * `events` and `numbered` have none: RecordLifecycle does them.
 */
const TARGETS: Partial<Record<Capability, Type>> = {
  tags: RecordTags,
  comments: RecordComments,
  attachments: RecordAttachments,
  revisions: RecordRevisions,
  pdf: RecordDocuments,
  bulk: RecordBulk,
  watch: RecordSubscriptions,
  search: RecordSearch,
  transfer: RecordTransfer,
};

/**
 * What a feature's module adds for its records (record.ts): the recycle
 * bin's restore route (softDelete) and the record routes of its
 * capabilities (in notes' order: the OpenAPI document's), and the
 * providers: its declaration, table and contract, RecordStore,
 * RecordLifecycle and RecordPresenter (the service and controller call
 * them), its list's registration (GET /v1/lists/{subject}), and each
 * capability's target. `override` replaces a target with
 * the feature's own.
 *
 * ```ts
 * const parts = recordParts(INVOICE, { service: InvoicesService, policy: InvoicePolicy, table: invoices, list: INVOICE_LIST, schemas: INVOICE_SCHEMAS });
 * @Module({ controllers: [InvoicesController, ...parts.controllers], providers: [InvoicesService, InvoicePolicy, ...parts.providers] })
 * ```
 */
export function recordParts(
  declaration: RecordDeclaration,
  options: {
    service: Type;
    policy: Type;
    table: unknown;
    list: RecordList;
    schemas: RecordSchemas;
    override?: Partial<Record<Capability, Type>>;
  },
) {
  const has = (capability: Capability) => takes(declaration, capability);
  const controllers: Type[] = [
    ...(declaration.softDelete
      ? [
          restoreRoutes(declaration, {
            policy: options.policy,
            schemas: options.schemas,
          }),
        ]
      : []),
    ...(has('comments') ? [commentRoutes(declaration)] : []),
    ...(has('attachments') ? [attachmentRoutes(declaration)] : []),
    ...(has('tags') ? [tagRoutes(declaration)] : []),
    ...(has('revisions')
      ? [revisionRoutes(declaration, { restored: options.schemas.response })]
      : []),
    ...(has('pdf')
      ? [documentRoutes(declaration, { source: recordKey(declaration) })]
      : []),
    ...(has('bulk')
      ? [
          bulkRoutes(declaration, {
            name: declaration.path,
            body: options.schemas.bulk,
            docs: {
              summary: `Act on many ${declaration.path.replace(/-/g, ' ')} at once`,
              description:
                'Each one as its own route does it (permissions, audit); one that fails does not stop the others. Up to BULK_SYNC_LIMIT ids answer 200 with a result each; more, or a `filter`, answer 202: follow it at GET /v1/bulk/{id}.',
            },
          }),
        ]
      : []),
    ...(has('watch') ? [watchRoutes(declaration)] : []),
  ];
  const providers: Provider[] = [
    { provide: RECORD_DECLARATION, useValue: declaration },
    { provide: RECORD_TABLE, useValue: options.table },
    // The policy class: what a record's `can` (?include=can) checks, as its routes do.
    { provide: RECORD_POLICY, useValue: options.policy },
    {
      provide: RECORD_CONTRACT,
      useFactory: (
        service: RecordContract['service'],
        policy: RecordContract['policy'],
      ) => ({
        declaration,
        service,
        policy,
        table: options.table as Record<string, AnyPgColumn>,
        list: options.list,
        schemas: options.schemas,
      }),
      inject: [options.service, options.policy],
    },
    RecordStore,
    RecordLifecycle,
    RecordPresenter,
    // GET /v1/lists/{subject}: its list described.
    listSource(declaration.subject, options.list),
    ...declaration.capabilities.flatMap((capability) => {
      const target = options.override?.[capability] ?? TARGETS[capability];
      return target ? [target] : [];
    }),
  ];
  return { controllers, providers };
}
