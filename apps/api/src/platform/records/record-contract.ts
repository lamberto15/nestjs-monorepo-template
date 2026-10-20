import { Inject, Injectable, type Type } from '@nestjs/common';
import { AuthorizationService } from '@nestjs/authorization';
import { Webhooks } from '@nestjs/webhooks';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { List, ListQuery } from '../../core/http/list-query.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { applyingEffect } from './record-approvals.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { RevisionsService } from '../revisions/revisions.service.js';
import { SequencesService } from '../sequences/sequences.service.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { TagsService } from '../tags/tags.service.js';
import {
  numberFormat,
  type RecordDeclaration,
  recordKey,
  recordSnapshot,
  recordTableOf,
  recordValues,
  recordView,
  takes,
} from './record.js';
import type { RecordList } from './record-list.js';
import {
  recordCan,
  recordCanActions,
  type RecordInclude,
  withCan,
} from './record-can.js';
import type { RecordSchemas } from './record.schemas.js';

/** A feature module's record declaration (record-parts.ts provides it). */
export const RECORD_DECLARATION = Symbol('RECORD_DECLARATION');
/** A feature module's record table (record-parts.ts provides it, for RecordStore). */
export const RECORD_TABLE = Symbol('RECORD_TABLE');
/** A feature module's record contract: its service, policy, table, list and schemas. */
export const RECORD_CONTRACT = Symbol('RECORD_CONTRACT');
/** A feature module's policy class (record-parts.ts provides it): the checks a record's `can` repeats. */
export const RECORD_POLICY = Symbol('RECORD_POLICY');

/** A row of a record's table, as the generic targets handle it. */
export type RecordRow = { id: string; ownerId: string } & Record<
  string,
  unknown
>;

/**
 * What a feature's service offers the platform's generic targets
 * (record-targets.ts): the standard methods `pnpm feature:add` writes.
 */
export interface RecordServiceContract {
  create(owner: Principal, dto: Record<string, unknown>): Promise<RecordRow>;
  findOne(
    id: string,
    db?: Database | Transaction,
    options?: { deleted?: boolean },
  ): Promise<RecordRow>;
  update(
    by: Principal,
    row: RecordRow,
    dto: Record<string, unknown>,
    ip?: string,
    options?: { restoredFrom?: number },
  ): Promise<RecordRow>;
  delete(by: Principal, row: RecordRow, ip?: string): Promise<void>;
  restore?(by: Principal, row: RecordRow, ip?: string): Promise<RecordRow>;
  query<T>(read: (db: Database) => Promise<T>): Promise<T>;
}

/** What a feature's policy offers: whether the principal may read or change a record. */
export interface RecordPolicyContract {
  read(user: Principal | null, row: RecordRow): Promise<boolean>;
  update(user: Principal | null, row: RecordRow): Promise<boolean>;
}

export interface RecordContract {
  declaration: RecordDeclaration;
  service: RecordServiceContract;
  policy: RecordPolicyContract;
  table: Record<string, AnyPgColumn>;
  list: RecordList;
  schemas: RecordSchemas;
}

/** The changes a record's `events` capability sends as webhooks (`<item>.created`…). */
export type RecordEvent = 'created' | 'updated' | 'deleted' | 'restored';

/**
 * What happens with every record of the feature, as its capabilities say,
 * in the write's transaction: it gets its number (numbered), the owner
 * watches a new one (watch), each state is a revision (revisions), each
 * change is a webhook (events), a body's custom values are checked
 * (custom). The service always calls it, so adding a capability changes no
 * service.
 */
@Injectable()
export class RecordLifecycle {
  constructor(
    @Inject(RECORD_DECLARATION) private readonly declaration: RecordDeclaration,
    private readonly subscriptions: SubscriptionsService,
    private readonly revisions: RevisionsService,
    private readonly sequences: SequencesService,
    private readonly webhooks: Webhooks<Transaction>,
    private readonly access: AccessService,
    private readonly customFields: CustomFieldsService,
    private readonly approvals: ApprovalsService,
  ) {}

  private snapshot(row: Record<string, unknown>) {
    return recordSnapshot(this.declaration, recordView(this.declaration, row));
  }

  /**
   * A create or update body as the table's columns (money, datetimes
   * mapped; with custom fields, `custom` checked against the subject's
   * active fields: defaults filled on create, a patch merged into the
   * stored values on update). Call it before the write's transaction: a
   * validation error then costs no transaction.
   */
  async values(
    dto: Record<string, unknown>,
    mode: 'create' | 'update',
  ): Promise<Record<string, unknown>> {
    const { custom, ...rest } = dto;
    const values = recordValues(this.declaration, rest);
    if (!takes(this.declaration, 'custom')) {
      return values;
    }
    const subject = this.declaration.subject;
    const parsed = await this.customFields.parseValues(
      subject,
      custom as Record<string, unknown> | undefined,
      mode,
    );
    if (mode === 'create') {
      return { ...values, custom: parsed };
    }
    // Only the keys sent change (jsonb ||); null removes one.
    return Object.keys(parsed).length > 0
      ? {
          ...values,
          custom: this.customFields.mergeValues(
            recordTableOf(this.declaration).custom!,
            parsed,
          ),
        }
      : values;
  }

  /**
   * The values a new record's insert takes besides its own: its number
   * (numbered), gapless per tenant, from the transaction's counter.
   */
  async creating(tx: Transaction): Promise<{ number?: string }> {
    if (!takes(this.declaration, 'numbered')) {
      return {};
    }
    const { formatted } = await this.sequences.next(
      tx,
      recordKey(this.declaration),
      numberFormat(this.declaration),
    );
    return { number: formatted };
  }

  /**
   * An `events` webhook (`<item>.created`…), through the outbox in the
   * write's transaction: it goes out if and only if the write commits.
   * The data is the record as the API shows it, less the fields its
   * receiver may not read. Endpoints belong to API clients, so it goes to
   * the client that owns the record (a user's records send none), as the
   * example feature's do. Without an endpoint subscribed it is a no-op.
   */
  private async emit(tx: Transaction, event: RecordEvent, row: RecordRow) {
    if (
      !takes(this.declaration, 'events') ||
      !row.ownerId.startsWith('client:')
    ) {
      return;
    }
    const client = row.ownerId.slice('client:'.length);
    const receiver = {
      kind: 'client',
      id: client,
      name: client,
      tenantId: row.tenantId as string,
    } as const;
    const data = await this.access.redact(
      receiver,
      'read',
      this.declaration.subject,
      recordView(this.declaration, row),
    );
    await this.webhooks.dispatch(tx, {
      type: `${recordKey(this.declaration)}.${event}`,
      tenant: client,
      data,
    });
  }

  async created(
    tx: Transaction,
    { row, owner, by }: { row: RecordRow; owner: Principal; by: Principal },
  ) {
    const subject = this.declaration.subject;
    if (takes(this.declaration, 'watch')) {
      // Its owner watches it: told of changes others make.
      await this.subscriptions.subscribe(owner, { subject, recordId: row.id });
    }
    if (takes(this.declaration, 'revisions')) {
      // Revision 1: the first state, restorable like any later one.
      await this.revisions.record(tx, subject, row.id, {
        snapshot: this.snapshot(row),
        by,
      });
    }
    await this.emit(tx, 'created', row);
  }

  /**
   * With approvable actions (`approvals`): the record can't change or go
   * while any request on it is being decided (409 `approval_pending`), and
   * a request sent back for changes goes with the record. Inside the
   * write's transaction: the record's approval lock is held until it
   * commits. The writes of an approval effect (applyEffect(): one approved,
   * or one run at once) are exempt, so a sibling action's open request
   * doesn't stall them.
   */
  private async waiting(tx: Transaction, by: Principal | null, id: string) {
    if (Object.keys(this.declaration.approvals ?? {}).length === 0) {
      return;
    }
    if (!applyingEffect()) {
      await this.approvals.assertNotPending(this.declaration.subject, id);
    }
    if (by) {
      await this.approvals.withdraw(tx, by, this.declaration.subject, id);
    }
  }

  /** Before a record goes (to the recycle bin or for good). */
  async deleting(
    tx: Transaction,
    { row, by }: { row: RecordRow; by: Principal },
  ) {
    await this.waiting(tx, by, row.id);
  }

  async updated(
    tx: Transaction,
    {
      before,
      after,
      by,
      restoredFrom,
    }: {
      before: RecordRow;
      after: RecordRow;
      by: Principal;
      restoredFrom?: number;
    },
  ) {
    await this.waiting(tx, null, after.id);
    if (takes(this.declaration, 'revisions')) {
      await this.revisions.record(tx, this.declaration.subject, after.id, {
        snapshot: this.snapshot(after),
        before: this.snapshot(before),
        by,
        restoredFrom,
      });
    }
    await this.emit(tx, 'updated', after);
  }

  /** `row` as it is once deleted (in the recycle bin, or as it was when deleted for good). */
  async deleted(tx: Transaction, { row }: { row: RecordRow }) {
    await this.emit(tx, 'deleted', row);
  }

  /** `row` as it is once restored from the recycle bin. */
  async restored(tx: Transaction, { row }: { row: RecordRow }) {
    await this.emit(tx, 'restored', row);
  }
}

/**
 * Records as a caller reads them: the API's view (money as objects), their
 * tags (tags), their active custom values (custom), less the fields the caller may not see,
 * and with `?include=can` what the caller may do with each (record-can.ts). The controller
 * always calls it (and its ETags cover what it returns, `can` aside).
 */
@Injectable()
export class RecordPresenter {
  constructor(
    @Inject(RECORD_DECLARATION) private readonly declaration: RecordDeclaration,
    @Inject(RECORD_POLICY) private readonly policy: Type,
    private readonly access: AccessService,
    private readonly authorization: AuthorizationService,
    private readonly tags: TagsService,
    private readonly customFields: CustomFieldsService,
    private readonly documents: DocumentsService,
  ) {}

  /**
   * A list request's query, the only way a record's list route gets one:
   * validated against the list with the custom fields defined now (a 400
   * naming what is wrong), then refused (403 `field_forbidden`) when it
   * filters, searches, sorts or selects by a field the caller may read on
   * no record, or filters, searches or sorts by one shown on some of the
   * rows it reaches only (`AccessService.assertQueryFields`). Answers the list it was
   * checked against too: its `where()`, `sortSelect()` and `pick()`.
   */
  async query(
    user: Principal,
    list: List,
    raw: Record<string, unknown>,
  ): Promise<{ list: List; query: ListQuery }> {
    const extended = takes(this.declaration, 'custom')
      ? await this.customFields.extendList(list, this.declaration.subject)
      : list;
    // `include` is no filter: the route reads it (`@Query('include', IncludePipe)`).
    const { include: _include, ...filters } = raw;
    const query = extended.parse(filters);
    // Matched among the rows the list reaches: the recycle bin's
    // (?deleted=true) are those the caller may restore, as the list route's
    // sqlFilter() reads them.
    await this.access.assertQueryFields(user, this.declaration.subject, query, {
      reach: query.deleted ? 'restore' : 'read',
    });
    return { list: extended, query };
  }

  /** One record, as the caller may see it (with `include.can`, its `can`). */
  async one(
    user: Principal,
    row: Record<string, unknown>,
    include?: RecordInclude,
  ) {
    const [shown] = await this.many(user, [row]);
    return include?.can ? withCan(shown!, await this.can(user, [row])) : shown!;
  }

  /**
   * A list's page as the caller may see it: each record shown, then only
   * the `?fields=` asked for (`list.pick`, after redaction), then with
   * `include.can` each one's `can` (whatever `fields` picked).
   */
  async page<P extends { items: Record<string, unknown>[] }>(
    user: Principal,
    page: P,
    {
      list,
      query,
      include,
    }: { list: List; query: ListQuery; include?: RecordInclude },
  ) {
    const picked = list.pick(
      { ...page, items: await this.many(user, page.items) },
      query,
    );
    if (!include?.can) {
      return picked;
    }
    const can = await this.can(user, page.items);
    return {
      ...picked,
      items: picked.items.map((item) =>
        withCan(item as Record<string, unknown>, can),
      ),
    };
  }

  /**
   * Each row's `can`, by id (record-can.ts): its policy's checks, in
   * memory; `issue` with the pdf capability (the checks of POST …/{id}/pdf).
   */
  private can(user: Principal, rows: Record<string, unknown>[]) {
    return recordCan(
      this.authorization,
      this.policy,
      user,
      rows as { id: string }[],
      recordCanActions(this.declaration.softDelete),
      takes(this.declaration, 'pdf')
        ? {
            issue: this.documents.issueFlag(user, recordKey(this.declaration)),
          }
        : {},
    );
  }

  /** Records, as the caller may see them (one tag query for them all). */
  async many(user: Principal, rows: Record<string, unknown>[]) {
    // The tenant is the request's own (docs/tenancy.md): not in a record's representation.
    let views: Record<string, unknown>[] = rows.map((row) => {
      const { tenantId: _tenantId, ...view } = recordView(
        this.declaration,
        row,
      ) as Record<string, unknown>;
      return view;
    });
    if (takes(this.declaration, 'tags')) {
      const tags = await this.tags.tagsOf(
        this.declaration.subject,
        views.map((view) => view.id as string),
      );
      views = views.map((view) => ({
        ...view,
        tags: tags.get(view.id as string) ?? [],
      }));
    }
    if (takes(this.declaration, 'custom')) {
      // Only the values of the fields active now (a deactivated one's stay stored).
      views = await this.customFields.visible(this.declaration.subject, views);
    }
    return this.access.redactAll(user, 'read', this.declaration.subject, views);
  }
}
