import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import { AuthorizationService } from '@nestjs/authorization';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { and, desc, eq, getTableColumns, inArray, lt } from 'drizzle-orm';
import {
  RANK_CAP,
  headline,
  matches,
  rank,
  vectorOf,
} from '../../core/database/search.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { walkList } from '../../core/http/pagination.js';
import { validationException } from '../../core/http/problem-details.filter.js';
import { AccessService } from '../../iam/access/access.service.js';
import {
  type Principal,
  principalKey,
  type RequestPrincipal,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { PersonalDataRegistry } from '../account/personal-data.registry.js';
import { AttachmentsRegistry } from '../attachments/attachments.registry.js';
import { BulkRegistry } from '../bulk/bulk.registry.js';
import type { BulkSelection } from '../bulk/bulk.types.js';
import { CommentsRegistry } from '../comments/comments.registry.js';
import { DataTransferRegistry } from '../data-transfer/data-transfer.registry.js';
import { columnsOf } from '../data-transfer/import-columns.js';
import type {
  ImportColumn,
  TransferColumn,
} from '../data-transfer/data-transfer.types.js';
import {
  type DocumentRenderOptions,
  DocumentsRegistry,
} from '../documents/documents.registry.js';
import { z } from 'zod';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { searchableFields } from '../fields/fields.js';
import {
  type RevisionItem,
  RevisionsRegistry,
} from '../revisions/revisions.registry.js';
import { SearchRegistry, type SearchHit } from '../search/search.registry.js';
import { SubscriptionsRegistry } from '../subscriptions/subscriptions.registry.js';
import { TagsRegistry } from '../tags/tags.registry.js';
import { TagsService } from '../tags/tags.service.js';
import {
  type RecordDeclaration,
  recordKey,
  recordSnapshot,
  recordView,
  sentFields,
  takes,
} from './record.js';
export { recordKey } from './record.js';
import {
  RECORD_CONTRACT,
  type RecordContract,
  RecordPresenter,
  type RecordRow,
} from './record-contract.js';

/**
 * The capabilities' targets for any record (record.ts), each registered in
 * its platform registry with the feature's service and policy (its
 * RecordContract): a capability declared is a capability working, with no
 * code in the feature. A feature replaces one with its own (recordParts'
 * `override`) when its records need more: notes' revisions and PDF know
 * custom fields.
 */

/** The record's first `.searchable()` or string field: what it is called by (comments, search, PDF). */
export const titleOf = (
  declaration: RecordDeclaration,
  row: Record<string, unknown>,
) => {
  const name =
    searchableFields(declaration.fields)[0] ??
    Object.entries(declaration.fields).find(
      ([, f]) => f.kind === 'string',
    )?.[0];
  const value = name ? row[name] : null;
  return typeof value === 'string' && value
    ? value
    : `${declaration.noun} ${row.id as string}`;
};

/**
 * The record, or null when it doesn't exist (or is in the recycle bin); with
 * `visibleTo`, null too when that principal may not read it (in the query).
 */
async function find(c: RecordContract, id: string, visibleTo?: Principal) {
  try {
    return await c.service.findOne(id, undefined, { visibleTo });
  } catch (error) {
    if (error instanceof NotFoundException) return null;
    throw error;
  }
}

/** Who may change a record tags it (platform/tags). */
@Injectable()
export class RecordTags {
  readonly subject: string;
  constructor(
    @Inject(RECORD_CONTRACT) private readonly c: RecordContract,
    registry: TagsRegistry,
  ) {
    this.subject = c.declaration.subject;
    registry.register(this);
  }
  /**
   * A 404 when it doesn't exist (or is in the recycle bin) or the principal
   * may not read it (the same 404); false (a 403) when they read but may not change it.
   */
  async canTag(principal: Principal, id: string) {
    return this.c.policy.update(
      principal,
      await this.c.service.findOne(id, undefined, { visibleTo: principal }),
    );
  }
}

/** Who may read a record reads and writes its comments; who may change it moderates them. */
@Injectable()
export class RecordComments {
  readonly subject: string;
  readonly commentedType: string;
  constructor(
    @Inject(RECORD_CONTRACT) private readonly c: RecordContract,
    registry: CommentsRegistry,
  ) {
    this.subject = c.declaration.subject;
    this.commentedType = `${recordKey(c.declaration)}.commented`;
    registry.register(this);
  }
  /** False when it doesn't exist (or is in the recycle bin) too: the comments' routes answer both with one 404. */
  async canRead(principal: Principal, id: string) {
    const row = await find(this.c, id, principal);
    return row !== null && this.c.policy.read(principal, row);
  }
  async canModerate(principal: Principal, id: string) {
    return this.c.policy.update(principal, await this.c.service.findOne(id));
  }
  link(id: string) {
    return `/${this.c.declaration.path}/${id}`;
  }
  async title(id: string) {
    return titleOf(this.c.declaration, await this.c.service.findOne(id));
  }
}

/** Who may read a record sees its attachments; who may change it adds and removes them. */
@Injectable()
export class RecordAttachments {
  readonly subject: string;
  readonly records: { table: PgTable; id: AnyPgColumn };
  constructor(
    @Inject(RECORD_CONTRACT) private readonly c: RecordContract,
    private readonly access: AccessService,
    registry: AttachmentsRegistry,
  ) {
    this.subject = c.declaration.subject;
    this.records = { table: c.table as unknown as PgTable, id: c.table.id! };
    registry.register(this);
  }
  async canRead(principal: Principal, id: string) {
    const row = await find(this.c, id, principal);
    return row !== null && this.c.policy.read(principal, row);
  }
  async canWrite(principal: Principal, id: string) {
    const row = await find(this.c, id);
    return row !== null && this.c.policy.update(principal, row);
  }
  /** Every one of these fields, as reading the record would show them (an issued PDF's). */
  async canReadFields(
    principal: Principal,
    id: string,
    fields: readonly string[],
  ) {
    const row = await find(this.c, id);
    if (!row || !(await this.c.policy.read(principal, row))) return false;
    const shown = await this.access.redact(
      principal,
      'read',
      this.subject,
      recordView(this.c.declaration, row),
    );
    return fields.every((field) => field in shown);
  }
}

/** Who may read a record may watch it (platform/subscriptions). */
@Injectable()
export class RecordSubscriptions {
  readonly subject: string;
  constructor(
    @Inject(RECORD_CONTRACT) private readonly c: RecordContract,
    private readonly authorization: AuthorizationService,
    registry: SubscriptionsRegistry,
  ) {
    this.subject = c.declaration.subject;
    registry.register(this);
  }
  /** A 404 when it doesn't exist or the principal may not read it: the same one. */
  async assertCanWatch(principal: Principal, recordId: string) {
    const row = await this.c.service.findOne(recordId, undefined, {
      visibleTo: principal,
    });
    if (!(await this.c.policy.read(principal, row))) {
      throw new ForbiddenException();
    }
    void this.authorization;
  }
}

/** Many records at once (POST /<x>/bulk), each as its own route does it. */
@Injectable()
export class RecordBulk {
  readonly name: string;
  readonly subject: string;
  readonly actions: Record<
    string,
    { label: string; permission: string; input?: unknown }
  >;
  readonly filters: RecordContract['list']['schema'];
  constructor(
    @Inject(RECORD_CONTRACT) private readonly c: RecordContract,
    private readonly access: AccessService,
    registry: BulkRegistry,
  ) {
    const soft = c.declaration.softDelete;
    this.name = c.declaration.path;
    this.subject = c.declaration.subject;
    this.actions = {
      delete: {
        label: soft ? 'Delete (to the recycle bin)' : 'Delete',
        permission: 'delete',
      },
      ...(soft && {
        restore: {
          label: 'Restore from the recycle bin',
          permission: 'restore',
        },
      }),
      update: {
        label: 'Change',
        permission: 'update',
        input: c.schemas.update,
      },
    };
    this.filters = c.list.schema;
    registry.register(this as never);
  }
  async *select(
    principal: Principal,
    action: string,
    selection: BulkSelection,
  ) {
    const table = this.c.table;
    const where = and(
      await this.access.sqlFilter(principal, this.subject, action, {
        deleted: this.c.declaration.softDelete && action === 'restore',
      }),
      selection.ids
        ? inArray(table.id!, selection.ids)
        : this.c.list.where(selection.filter as ListQuery),
    );
    let cursor: string | undefined;
    for (;;) {
      const rows = (await this.c.service.query((db) =>
        db
          .select()
          .from(table as never)
          .where(and(where, cursor ? lt(table.id!, cursor) : undefined))
          .orderBy(desc(table.id!))
          .limit(500),
      )) as RecordRow[];
      if (rows.length === 0) return;
      yield rows;
      cursor = rows[rows.length - 1]!.id;
    }
  }
  async perform(
    principal: Principal,
    action: string,
    selected: RecordRow,
    input: unknown,
    ip?: string,
  ) {
    // As it is now (a 404 or 403 fails this item alone).
    const row = await this.c.service.findOne(selected.id, undefined, {
      deleted: action === 'restore',
    });
    if (!(await this.access.can(principal, action, this.subject, row))) {
      throw new ForbiddenException();
    }
    if (action === 'delete') {
      await this.c.service.delete(principal, row, ip);
    } else if (action === 'restore') {
      await this.c.service.restore!(principal, row, ip);
    } else {
      const dto = input as Record<string, unknown>;
      const forbidden = await this.access.forbiddenFields(
        principal,
        'update',
        this.subject,
        sentFields(dto),
        row,
      );
      if (forbidden.length) {
        throw new ForbiddenException({
          code: 'field_forbidden',
          message: `You may not change: ${forbidden.join(', ')}.`,
          fields: forbidden,
        });
      }
      await this.c.service.update(principal, row, dto, ip);
    }
  }
}

/** Records in the global search (GET /v1/search): those the principal may read, best match first. */
@Injectable()
export class RecordSearch {
  readonly subject: string;
  constructor(
    @Inject(RECORD_CONTRACT) private readonly c: RecordContract,
    private readonly access: AccessService,
    registry: SearchRegistry,
  ) {
    this.subject = c.declaration.subject;
    registry.register(this);
  }
  async search(
    principal: Principal,
    q: string,
    limit: number,
  ): Promise<SearchHit[]> {
    const table = this.c.table;
    const fields = this.c.declaration.fields;
    // Long texts first (a body says more than a title), then the rest.
    const searchable = searchableFields(fields).sort(
      (a, b) =>
        Number(fields[b]!.kind === 'text') - Number(fields[a]!.kind === 'text'),
    );
    // Field-level: a field the principal may read on no record, or on some
    // records only, isn't matched (a hit would tell its text where it is
    // hidden): a vector of the others, made now, without the index
    // (docs/permissions.md).
    const unmatchable = await this.access.unmatchableFields(
      principal,
      'read',
      this.subject,
    );
    const visible = searchable.filter((name) => !unmatchable.includes(name));
    if (visible.length === 0) return [];
    const vector =
      visible.length === searchable.length
        ? table.search!
        : vectorOf(visible.map((name) => table[name]!));
    const where = and(
      await this.access.sqlFilter(principal, this.subject, 'read'),
      matches(vector, q),
    );
    const score = rank(vector, q);
    const rows = (await this.c.service.query((db) =>
      db
        // The whole row: the permission conditions (`mine`) read it.
        .select({
          ...getTableColumns(
            table as unknown as Parameters<typeof getTableColumns>[0],
          ),
          score,
          // A snippet of each searchable field, its own key next to the row's.
          ...Object.fromEntries(
            searchable.map((name) => [
              `${SNIPPET}${name}`,
              headline(table[name]!, q),
            ]),
          ),
        })
        .from(table as never)
        // The best of the newest RANK_CAP matches: ranking reads every row it ranks.
        .where(
          and(
            where,
            inArray(
              table.id!,
              db
                .select({ id: table.id! })
                .from(table as never)
                .where(where)
                .orderBy(desc(table.id!))
                .limit(RANK_CAP),
            ),
          ),
        )
        .orderBy(desc(score), desc(table.id!))
        .limit(limit),
    )) as Record<string, unknown>[];
    const shown = await this.access.redactAll(
      principal,
      'read',
      this.subject,
      rows,
    );
    return shown.map((row) => ({
      subject: this.subject,
      id: row.id as string,
      title: titleOf(this.c.declaration, row),
      // Field-level permissions: only a snippet of a field still shown
      // after redaction, and only one that highlights a match.
      snippet:
        searchable
          .filter((name) => name in row && row[name] != null)
          .map((name) => row[`${SNIPPET}${name}`] as string | null)
          .find((snippet) => snippet?.includes('<b>')) ?? null,
      score: Number(row.score),
      link: `/${this.c.declaration.path}/${row.id as string}`,
    }));
  }
}

/** The key of a field's snippet in a search row (beside the row's own columns). */
const SNIPPET = '__snippet_';

/** A record's revisions: its fields after each change; restored through the service (a PATCH's checks). */
@Injectable()
export class RecordRevisions {
  readonly subject: string;
  constructor(
    @Inject(RECORD_CONTRACT) private readonly c: RecordContract,
    private readonly access: AccessService,
    // The answer a GET gives (tags too), so a restore's ETag is the GET's.
    private readonly presenter: RecordPresenter,
    private readonly customFields: CustomFieldsService,
    registry: RevisionsRegistry,
  ) {
    this.subject = c.declaration.subject;
    registry.register(this);
  }
  private view(row: Record<string, unknown>) {
    return recordView(this.c.declaration, row);
  }
  async canRead(principal: Principal, id: string) {
    const row = await find(this.c, id, principal);
    return row !== null && this.c.policy.read(principal, row);
  }
  async canRestore(principal: Principal, id: string) {
    const row = await find(this.c, id);
    return row !== null && this.c.policy.update(principal, row);
  }
  snapshot(row: Record<string, unknown>): Record<string, unknown> {
    return recordSnapshot(this.c.declaration, this.view(row));
  }

  /**
   * The custom values to set back: those of the active fields that differ
   * from the record's now (a value the snapshot lacks is removed: null);
   * fields deactivated since stay as they are.
   */
  private async customPatch(was: unknown, now: unknown) {
    const subject = this.c.declaration.subject;
    const [then, current] = await this.customFields.visible(subject, [
      { custom: (was ?? {}) as Record<string, unknown> },
      { custom: (now ?? {}) as Record<string, unknown> },
    ]);
    const patch: Record<string, unknown> = {};
    for (const key of new Set([
      ...Object.keys(then!.custom),
      ...Object.keys(current!.custom),
    ])) {
      const value = then!.custom[key] ?? null;
      if (
        JSON.stringify(value) !== JSON.stringify(current!.custom[key] ?? null)
      ) {
        patch[key] = value;
      }
    }
    return patch;
  }
  async apply(
    principal: Principal,
    id: string,
    fields: Record<string, unknown>,
    {
      ip,
      restoredFrom,
      unchanged,
    }: {
      ip?: string;
      restoredFrom: number;
      unchanged?: (current: object) => void;
    },
  ) {
    const updated = await this.c.service.update(principal, { id }, {}, ip, {
      restoredFrom,
      prepareCurrent: async (current) => {
        const now = this.snapshot(current);
        const changes: Record<string, unknown> = Object.fromEntries(
          Object.entries(fields).filter(
            ([field, value]) =>
              field !== 'custom' &&
              field in now &&
              JSON.stringify(value) !== JSON.stringify(now[field]),
          ),
        );
        if (takes(this.c.declaration, 'custom')) {
          const patch = await this.customPatch(fields.custom, current.custom);
          if (Object.keys(patch).length > 0) changes.custom = patch;
        }
        const parsed = this.c.schemas.update.safeParse(changes);
        if (!parsed.success) {
          throw validationException(parsed.error.issues);
        }
        return parsed.data as Record<string, unknown>;
      },
      assertCurrent: async (current, dto) => {
        if (!(await this.c.policy.update(principal, current))) {
          throw new ForbiddenException(
            `You may not change this ${this.c.declaration.noun}.`,
          );
        }
        unchanged?.(await this.presenter.one(principal, current));
        const currentForbidden = await this.access.forbiddenFields(
          principal,
          'update',
          this.subject,
          sentFields(dto),
          current,
        );
        if (currentForbidden.length) {
          throw new ForbiddenException({
            code: 'field_forbidden',
            message: `You may not change: ${currentForbidden.join(', ')}.`,
            fields: currentForbidden,
          });
        }
      },
    });
    return this.presenter.one(principal, updated);
  }
  async shown(principal: Principal, id: string) {
    return this.presenter.one(principal, await this.c.service.findOne(id));
  }
  /** Without the fields the reader's permissions leave out, in the snapshots and in the changes. */
  async redact(
    principal: Principal,
    id: string,
    items: RevisionItem[],
  ): Promise<RevisionItem[]> {
    const row = this.view(await this.c.service.findOne(id));
    const custom = takes(this.c.declaration, 'custom');
    // Custom values: only those of the fields active now, in the snapshots and in the changes (`custom.<key>`).
    let snapshots = items.map(({ snapshot }) => snapshot);
    let active = new Set<string>();
    if (custom) {
      snapshots = await this.customFields.visible(
        this.subject,
        snapshots.map((snapshot) => ({
          ...snapshot,
          custom: (snapshot.custom ?? {}) as Record<string, unknown>,
        })),
      );
      const named = items.flatMap(({ changes }) =>
        Object.keys(changes ?? {})
          .filter((key) => key.startsWith('custom.'))
          .map((key) => key.slice('custom.'.length)),
      );
      const [probe] = await this.customFields.visible(this.subject, [
        { custom: Object.fromEntries(named.map((key) => [key, true])) },
      ]);
      active = new Set(Object.keys(probe!.custom));
    }
    return Promise.all(
      snapshots.map(async (kept, index) => {
        const allowed = await this.access.redact(
          principal,
          'read',
          this.subject,
          {
            ...row,
            ...kept,
          } as Record<string, unknown>,
        );
        const shown = Object.fromEntries(
          Object.entries(kept).filter(([field]) => field in allowed),
        );
        const changes = items[index]!.changes;
        return {
          snapshot: shown,
          changes:
            changes &&
            Object.fromEntries(
              Object.entries(changes).filter(([key]) => {
                const [field, sub] = key.split('.', 2) as [string, string?];
                if (!(field in shown)) return false;
                return (
                  field !== 'custom' || sub === undefined || active.has(sub)
                );
              }),
            ),
        };
      }),
    );
  }
}

/**
 * A record as a PDF (platform/documents): its fields as label and value,
 * in the requester's language and time zone, on the shared page
 * (documents/templates/record.html; `<item>.html` when the feature has
 * its own). Labels: `documents.<item>.fields.<field>` (`pnpm feature:sync`).
 */
@Injectable()
export class RecordDocuments {
  readonly name: string;
  readonly subject: string;
  constructor(
    @Inject(RECORD_CONTRACT) private readonly c: RecordContract,
    private readonly access: AccessService,
    private readonly i18n: I18nService,
    registry: DocumentsRegistry,
  ) {
    this.name = recordKey(c.declaration);
    this.subject = c.declaration.subject;
    registry.register(this);
  }
  canIssue() {
    return Promise.resolve(true);
  }
  async content(
    principal: RequestPrincipal,
    id: string,
    { locale, timezone, issuedAt }: DocumentRenderOptions,
  ) {
    const row = await this.c.service.findOne(id);
    if (!(await this.c.policy.read(principal, row))) {
      throw new NotFoundException(
        `${this.c.declaration.noun} ${id} not found.`,
      );
    }
    const shown = (await this.access.redact(
      principal,
      'read',
      this.subject,
      recordView(this.c.declaration, row),
    )) as Record<string, unknown>;
    const key = this.name;
    const label = (path: string, args?: Record<string, string>) =>
      this.i18n.translate(`documents.${key}.${path}`, { locale, args });
    const date = (value: Date) =>
      this.i18n.formatDate(value, {
        locale,
        dateStyle: 'long',
        timeStyle: 'short',
        timeZone: timezone,
      });
    const text = (value: unknown) =>
      value === null || value === undefined
        ? ''
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value as string | number | boolean);
    const fields = [
      ...(takes(this.c.declaration, 'numbered') ? ['number'] : []),
      ...Object.entries(this.c.declaration.fields)
        .filter(([name, f]) => f.kind !== 'json' && name in shown)
        .map(([name]) => name),
    ];
    return {
      template: 'record',
      fields,
      title: titleOf(this.c.declaration, row),
      fileName: `${this.c.declaration.path}-${row.id}`,
      context: {
        labels: {
          document: label('document'),
          issued: label('issued', { date: date(issuedAt) }),
        },
        title: titleOf(this.c.declaration, row),
        rows: fields.map((field) => ({
          label: label(`fields.${field}`),
          value: text(shown[field]),
        })),
      },
    };
  }
}

/**
 * Records as CSV, JSON or Excel (platform/data-transfer): exports of those
 * the principal may read; imports through the service's create (when no
 * required field is money or JSON, which a cell can't hold); a user's own
 * records in their data export.
 */
@Injectable()
export class RecordTransfer {
  readonly name: string;
  readonly subject: string;
  readonly columns: readonly TransferColumn[];
  readonly filters: RecordContract['list']['schema'];
  readonly schema?: RecordContract['schemas']['create'];
  // With custom fields (custom): one `custom.<key>` column per active field, both ways.
  columnsFor?: () => Promise<readonly TransferColumn[]>;
  templateColumns?: () => Promise<readonly ImportColumn[]>;
  schemaFor?: () => Promise<z.ZodType<Record<string, unknown>>>;
  refusedColumns?: (
    principal: Principal,
    headers: readonly string[],
  ) => Promise<string[]>;
  constructor(
    @Inject(RECORD_CONTRACT) private readonly c: RecordContract,
    private readonly access: AccessService,
    customFields: CustomFieldsService,
    private readonly tags: TagsService,
    registry: DataTransferRegistry,
    personalData: PersonalDataRegistry,
  ) {
    const fields = Object.entries(c.declaration.fields);
    this.name = c.declaration.path;
    this.subject = c.declaration.subject;
    this.columns = [
      { key: 'id' },
      ...(takes(c.declaration, 'numbered') ? [{ key: 'number' }] : []),
      ...fields.map(([name, f]): TransferColumn => {
        if (f.kind === 'money') {
          return {
            key: name,
            value: (row) => {
              const view = recordView(c.declaration, row) as Record<
                string,
                { amount: string; currency: string } | null
              >;
              const money = view[name];
              return money ? `${money.amount} ${money.currency}` : '';
            },
          };
        }
        if (f.kind === 'json')
          return {
            key: name,
            value: (row) => JSON.stringify(row[name] ?? null),
          };
        if (f.kind === 'datetime') return { key: name, type: 'datetime' };
        return { key: name };
      }),
      // Its tags' names, `Urgent, Q3` (batches() adds them, one query per
      // batch). Export only: an import's schema doesn't name `tags`, so the
      // column is ignored there.
      ...(takes(c.declaration, 'tags')
        ? [
            {
              key: 'tags',
              value: (row: Record<string, unknown>) =>
                ((row.tags as { name: string }[] | undefined) ?? [])
                  .map((tag) => tag.name)
                  .join(', '),
            } satisfies TransferColumn,
          ]
        : []),
      { key: 'ownerId', header: 'owner' },
      { key: 'createdAt', type: 'datetime' },
    ];
    this.filters = c.list.schema;
    const subject = this.subject;
    const custom = takes(c.declaration, 'custom');
    if (custom) {
      this.columnsFor = async () => [
        ...this.columns,
        ...(await customFields.transferColumns(subject)),
      ];
    }
    registry.registerExporter(this as never);
    const importable = fields.every(
      ([, f]) =>
        f.options.optional ||
        f.options.hasDefault ||
        !['money', 'json'].includes(f.kind),
    );
    if (importable) {
      const flat = Object.fromEntries(
        fields
          .filter(([, f]) => ['money', 'json'].includes(f.kind))
          .map(([name]) => [name, true]),
      );
      // The custom values come in their `custom.<key>` columns (schemaFor adds them).
      const row = c.schemas.create.omit({
        ...flat,
        ...(custom && { custom: true }),
        // Imported rows take the default naming series.
        ...(takes(c.declaration, 'numbered') && { namingSeriesId: true }),
      } as never) as unknown as z.ZodObject;
      this.schema = row as never;
      if (custom) {
        this.templateColumns = async () => [
          ...columnsOf(row),
          ...(await customFields.importColumns(subject)),
        ];
        this.schemaFor = () => customFields.importSchema(subject, row) as never;
        this.refusedColumns = (_principal, headers) =>
          customFields.unknownColumns(subject, headers);
      }
      registry.registerImporter(this as never);
    }
    personalData.register(this);
  }
  private async *pages(where: ReturnType<typeof and>) {
    const table = this.c.table;
    let cursor: string | undefined;
    for (;;) {
      const rows = (await this.c.service.query((db) =>
        db
          .select()
          .from(table as never)
          .where(and(where, cursor ? lt(table.id!, cursor) : undefined))
          .orderBy(desc(table.id!))
          .limit(1000),
      )) as RecordRow[];
      if (rows.length === 0) return;
      yield rows;
      cursor = rows[rows.length - 1]!.id;
    }
  }
  /** A person's data export: those they own (they stay when the account is deleted). */
  async *rows(user: UserPrincipal) {
    for await (const rows of this.pages(
      eq(this.c.table.ownerId!, principalKey(user)),
    )) {
      yield rows.map((row) => recordView(this.c.declaration, row)) as Record<
        string,
        unknown
      >[];
    }
  }
  /** The list's order (`query.sort`, else newest first), by keyset: what the list shows, page after page. */
  async *batches(principal: Principal, query: Record<string, unknown>) {
    const withTags = takes(this.c.declaration, 'tags');
    const list = query as ListQuery;
    const table = this.c.table;
    const pgTable = table as unknown as PgTable;
    const where = and(
      await this.access.sqlFilter(principal, this.subject, 'read'),
      this.c.list.where(list),
    );
    // Sort values that aren't columns, for the keyset (as the list selects them).
    const extra = this.c.list.sortSelect(list);
    for await (const rows of walkList(
      table.id!,
      list,
      async ({ after, orderBy, limit }) =>
        (await this.c.service.query((db) =>
          db
            .select({ ...getTableColumns(pgTable), ...extra })
            .from(pgTable)
            .where(and(where, after))
            .orderBy(...orderBy)
            .limit(limit),
        )) as RecordRow[],
    )) {
      if (!withTags) {
        yield rows;
        continue;
      }
      // One query for the batch's tags, as RecordPresenter does.
      const tags = await this.tags.tagsOf(
        this.subject,
        rows.map((row) => row.id as string),
      );
      yield rows.map((row) => ({
        ...row,
        tags: tags.get(row.id as string) ?? [],
      }));
    }
  }
  async write(principal: Principal, row: Record<string, unknown>) {
    await this.c.service.create(principal, row);
  }
}
