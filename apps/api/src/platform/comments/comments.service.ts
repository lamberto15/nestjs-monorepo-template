import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import { RecordPurgeRegistry } from '../../iam/resources/record-purge.registry.js';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  type Principal,
  principalKey,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import type { NotificationType } from '../notifications/notification.types.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PeopleService } from '../people/people.service.js';
import { RECORD_EVENTS, RecordActivity } from '../realtime/record-activity.js';
import type { RecordRef } from '../subscriptions/subscriptions.service.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import {
  PersonalDataRegistry,
  type PersonalDataSource,
} from '../account/personal-data.registry.js';
import { COMMENT_LIST } from './comment.list.js';
import type { CommentView } from './comment.schemas.js';
import { CommentsRegistry, type CommentTarget } from './comments.registry.js';
import { comments } from './comments.tables.js';

type Comment = typeof comments.$inferSelect;

/** The author of a comment whose account was deleted (the body becomes DELETED_BODY). */
export const ANONYMIZED_AUTHOR = 'anonymous';
export const DELETED_BODY = '[deleted]';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** At most this many people are mentioned in one comment (the rest are ignored). */
const MAX_MENTIONS = 20;
/** Notifications quote this much of the comment. */
const EXCERPT = 140;

/**
 * `@ada@example.com` or `@user:<uuid>`, after a space, a bracket or the
 * start (so an address in the text, `ada@example.com`, mentions nobody).
 * A sentence's full stop after an address isn't part of it.
 */
const MENTION =
  /(?<![\w@.])@(user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/gi;

/**
 * Comments on any feature's records, and the people they mention. A
 * feature registers its records (`CommentsRegistry`, a `CommentTarget`):
 * who may read a record may read and write its comments; the author edits
 * their own; the author or a moderator (`canModerate`) removes one.
 *
 * Each write is one transaction with its audit entry (`comment.added`,
 * `-edited`, `-removed`, the comment as target, the record in the
 * details) and its notifications: the people mentioned who may read the
 * record get `comment.mentioned`; the record's watchers (subscriptions),
 * but the author and those mentioned, get the feature's
 * `<subject>.commented`. The author watches the record from their first
 * comment on it. After the commit, the record's open pages hear of it
 * (`record.commented`, RecordActivity). Each comment carries its author's
 * name and those of the people it mentions (PeopleService), as every
 * member sees them.
 */
@Injectable()
export class CommentsService implements PersonalDataSource {
  readonly name = 'comments';

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly registry: CommentsRegistry,
    private readonly audit: AuditService,
    private readonly users: UsersRepository,
    private readonly notifications: NotificationsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly people: PeopleService,
    private readonly activity: RecordActivity,
    personalData: PersonalDataRegistry,
    purges: RecordPurgeRegistry,
  ) {
    personalData.register(this);
    // A record purged from its recycle bin: its comments go with it.
    purges.register({
      name: 'comments',
      forget: (tx, subject, ids) => this.forgetAll(tx, subject, ids),
    });
  }

  /** A page of a record's comments, oldest first unless the query sorts (a 403 when the principal may not read the record). */
  async list(principal: Principal, record: RecordRef, query: ListQuery) {
    await this.readable(principal, record);
    const where = and(this.of(record), COMMENT_LIST.where(query));
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(comments)
        .where(and(where, this.after(query)))
        .orderBy(...this.order(query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, comments, where, query),
    ]);
    const page = toPage(rows, query, total);
    // The authors' and the mentioned people's names in one query, whatever the page's size.
    const known = await this.nameMap(page.items, true);
    return {
      ...page,
      items: page.items.map((row) =>
        view(row, known.names.get(row.author) ?? null, known),
      ),
    };
  }

  /** Adds a comment; notifies those mentioned and the record's watchers. */
  async add(
    principal: Principal,
    record: RecordRef,
    body: string,
    ip?: string,
  ) {
    const target = await this.readable(principal, record);
    const mentions = await this.mentions(target, record, body, principal);
    const author = principalKey(principal);
    const row = await inTransaction(this.txHost, async (tx) => {
      const [earlier] = await tx
        .select({ id: comments.id })
        .from(comments)
        .where(and(this.of(record), eq(comments.author, author)))
        .limit(1);
      const [created] = await tx
        .insert(comments)
        .values({ ...record, author, body, mentions })
        .returning();
      await this.audit.record(
        principal,
        {
          action: 'comment.added',
          targetType: 'comment',
          targetId: created!.id,
          details: { ...record, mentions },
          ip,
        },
        tx,
      );
      await this.notify(tx, target, created!, principal, mentions, true);
      if (!earlier) {
        // Their first comment here: they hear of the answers.
        await this.subscriptions.subscribe(principal, record);
      }
      return created!;
    });
    this.notifications.deliverNow();
    this.pushed(target, principal, row, 'added');
    return view(row, principal.name, await this.nameMap([row]));
  }

  /** Changes the text of the principal's own comment; the people newly mentioned are told. */
  async edit(
    principal: Principal,
    record: RecordRef,
    id: string,
    body: string,
    ip?: string,
  ) {
    const target = await this.readable(principal, record);
    const comment = await this.findOne(record, id);
    if (comment.author !== principalKey(principal)) {
      throw new ForbiddenException('Only its author may change a comment.');
    }
    if (comment.body === body) {
      return view(comment, principal.name, await this.nameMap([comment]));
    }
    const mentions = await this.mentions(target, record, body, principal);
    const row = await inTransaction(this.txHost, async (tx) => {
      const [updated] = await tx
        .update(comments)
        .set({ body, mentions, editedAt: new Date() })
        .where(eq(comments.id, id))
        .returning();
      await this.audit.record(
        principal,
        {
          action: 'comment.edited',
          targetType: 'comment',
          targetId: id,
          // Not the texts: the log outlives an author's account (their comments are erased with it).
          details: { ...record, mentions },
          ip,
        },
        tx,
      );
      const added = mentions.filter((key) => !comment.mentions.includes(key));
      await this.notify(tx, target, updated!, principal, added, false);
      return updated!;
    });
    this.notifications.deliverNow();
    this.pushed(target, principal, row, 'edited');
    return view(row, principal.name, await this.nameMap([row]));
  }

  /** Removes a comment for good: its author, or a moderator of the record. */
  async remove(
    principal: Principal,
    record: RecordRef,
    id: string,
    ip?: string,
  ) {
    const target = await this.readable(principal, record);
    const comment = await this.findOne(record, id);
    if (
      comment.author !== principalKey(principal) &&
      !(await target.canModerate(principal, record.recordId))
    ) {
      throw new ForbiddenException(
        'Only its author or a moderator may remove a comment.',
      );
    }
    await inTransaction(this.txHost, async (tx) => {
      await tx.delete(comments).where(eq(comments.id, id));
      await this.audit.record(
        principal,
        {
          action: 'comment.removed',
          targetType: 'comment',
          targetId: id,
          details: { ...record, author: comment.author },
          ip,
        },
        tx,
      );
    });
    this.pushed(target, principal, comment, 'removed');
  }

  /** A user's own comments, newest first, in batches (their data export: `POST /account/export`). */
  async *rows(user: UserPrincipal) {
    const author = principalKey(user);
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.db
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.author, author),
            cursor ? lt(comments.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(comments.id))
        .limit(1000);
      if (rows.length === 0) return;
      // Not the names of those they mentioned: other people's data (their keys stay).
      yield rows.map((row) => {
        const { mentionNames: _, ...own } = view(row, user.name, NO_NAMES);
        return own;
      });
      cursor = rows[rows.length - 1]!.id;
    }
  }

  /**
   * An account's deletion: their comments stay (the conversation keeps
   * its shape) with "[deleted]" as the text and `anonymous` as the
   * author; where others mentioned them, the mention goes, and so does
   * their address in the text.
   */
  async erase(tx: Transaction, user: UserPrincipal) {
    const key = principalKey(user);
    await tx
      .update(comments)
      .set({ body: DELETED_BODY, author: ANONYMIZED_AUTHOR, mentions: [] })
      .where(eq(comments.author, key));
    const pattern = `@(${escapeRegExp(user.email)}|${escapeRegExp(key)})`;
    // The text too where the mention was dropped (they couldn't read the
    // record, or came after the twentieth): a scan, but the job is nightly.
    await tx
      .update(comments)
      .set({
        body: sql`regexp_replace(${comments.body}, ${pattern}, '@[deleted]', 'gi')`,
        mentions: sql`array_remove(${comments.mentions}, ${key})`,
      })
      .where(
        or(
          arrayContains(comments.mentions, [key]),
          sql`${comments.body} ~* ${pattern}`,
        ),
      );
  }

  /** When a record is gone for good: its comments go too (in that transaction). */
  async forget(tx: Transaction, record: RecordRef) {
    await this.forgetAll(tx, record.subject, [record.recordId]);
  }

  /** `forget()` for many records of a subject (the soft-delete purge's batch). */
  async forgetAll(tx: Transaction, subject: string, recordIds: string[]) {
    await tx
      .delete(comments)
      .where(
        and(
          eq(comments.subject, subject),
          inArray(comments.recordId, recordIds),
        ),
      );
  }

  /**
   * The record's target, once the principal may read the record: else a 404,
   * the same whether it doesn't exist or they may not read it (its existence
   * stays hidden: docs/permissions.md).
   */
  private async readable(principal: Principal, record: RecordRef) {
    const target = this.registry.get(record.subject);
    if (!(await target.canRead(principal, record.recordId))) {
      throw new NotFoundException(
        `${record.subject} ${record.recordId} not found.`,
      );
    }
    return target;
  }

  private async findOne(record: RecordRef, id: string) {
    const [row] = await this.db
      .select()
      .from(comments)
      .where(and(this.of(record), eq(comments.id, id)));
    if (!row) {
      throw new NotFoundException(`Comment ${id} not found.`);
    }
    return row;
  }

  /**
   * The principal keys of the active users the body mentions who are
   * members of the record's tenant and may read the record, but the
   * author; anyone else is silently left out (a mention never tells who
   * exists, or that the record does). Users are global: an address of
   * someone outside the tenant is nobody here (docs/tenancy.md).
   */
  private async mentions(
    target: CommentTarget,
    record: RecordRef,
    body: string,
    author: Principal,
  ) {
    const handles = handlesOf(body);
    const keys = new Set<string>();
    const tenantId = requireTenantId('A mention');
    for (const handle of handles) {
      const account = handle.startsWith('user:')
        ? UUID.test(handle.slice('user:'.length))
          ? await this.users.findActive(handle.slice('user:'.length))
          : null
        : (await this.users.findActiveByEmail(handle))?.user;
      // As a member of this tenant, or not at all.
      const user = account
        ? await this.users.inTenant(account.id, tenantId)
        : null;
      if (
        user?.tenantId === tenantId &&
        principalKey(user) !== principalKey(author) &&
        (await target.canRead(user, record.recordId))
      ) {
        keys.add(principalKey(user));
      }
    }
    return [...keys];
  }

  /**
   * The names `view()` needs for these comments: of their mentions (and
   * their authors', for a page), and of the addresses written in their
   * bodies that name one of those mentions (`@ada@example.com`): one
   * query for each, whatever the number of comments.
   */
  private async nameMap(rows: Comment[], authors = false): Promise<Names> {
    const addresses = new Set(rows.flatMap((row) => emailHandlesOf(row.body)));
    const [names, emails] = await Promise.all([
      this.people.names(
        rows.flatMap((row) =>
          authors ? [row.author, ...row.mentions] : row.mentions,
        ),
      ),
      // Only among the keys already mentioned: an address nobody resolved
      // stays without a name (a mention never tells who exists).
      addresses.size
        ? this.people.keysOfEmails(
            addresses,
            rows.flatMap((row) => row.mentions),
          )
        : new Map<string, string>(),
    ]);
    return { names, emails };
  }

  /** In the write's transaction: `comment.mentioned` to `mentioned`; on a new comment, the watchers too. */
  private async notify(
    tx: Transaction,
    target: CommentTarget,
    comment: Comment,
    by: Principal,
    mentioned: string[],
    watchers: boolean,
  ) {
    if (!mentioned.length && !watchers) return;
    const record = { subject: comment.subject, recordId: comment.recordId };
    const data = {
      recordId: comment.recordId,
      commentId: comment.id,
      title: await target.title(comment.recordId),
      by: by.name,
      excerpt: excerpt(comment.body),
    };
    const link = target.link(comment.recordId);
    await this.notifications.notify(tx, {
      type: 'comment.mentioned',
      to: mentioned,
      data: { subject: comment.subject, ...data },
      link,
    });
    if (!watchers) return;
    const skip = new Set([principalKey(by), ...comment.mentions]);
    const type = (target.commentedType ??
      `${target.subject.toLowerCase()}.commented`) as NotificationType;
    await this.notifications.notify(tx, {
      type,
      to: (await this.subscriptions.watchers(record)).filter(
        (watcher) => !skip.has(watcher),
      ),
      data,
      // Several comments collapse into one notification per record, counted up.
      key: `${type}:${comment.recordId}`,
      link,
    });
  }

  /**
   * After the commit: `record.commented` to the record's watchers and the
   * author's other tabs who may read it (RecordActivity). Not awaited: the
   * answer doesn't wait for the permission checks, and a failure is logged.
   */
  private pushed(
    target: CommentTarget,
    by: Principal,
    comment: Comment,
    action: 'added' | 'edited' | 'removed',
  ) {
    const record = { subject: comment.subject, recordId: comment.recordId };
    void this.activity.push(
      record,
      RECORD_EVENTS.commented,
      { commentId: comment.id, action },
      {
        by,
        canRead: (principal) => target.canRead(principal, record.recordId),
      },
    );
  }

  private of(record: RecordRef) {
    return and(
      eq(comments.subject, record.subject),
      eq(comments.recordId, record.recordId),
    );
  }

  /** Oldest first by default (a conversation reads down); `?sort=` as any list. */
  private order(query: ListQuery) {
    return query.sort?.length
      ? pageOrder(comments.id, query)
      : [asc(comments.id)];
  }

  private after(query: ListQuery) {
    if (!query.cursor || query.sort?.length) {
      return afterCursor(comments.id, query);
    }
    return gt(comments.id, query.cursor);
  }
}

/** What `view()` names: people by key, and the addresses (lower-cased) that resolve to one. */
interface Names {
  /** Principal key to name; holds at least the mentions' (PeopleService.names). */
  names: ReadonlyMap<string, string | null>;
  /** Address to the `user:<id>` it names (PeopleService.keysOfEmails). */
  emails: ReadonlyMap<string, string>;
}
const NO_NAMES: Names = { names: new Map(), emails: new Map() };

/**
 * The distinct handles a body mentions (`ada@example.com`, `user:<uuid>`),
 * lower-cased, the first MAX_MENTIONS: those the mention resolution looks at.
 */
const handlesOf = (body: string) =>
  [
    ...new Set([...body.matchAll(MENTION)].map((m) => m[1]!.toLowerCase())),
  ].slice(0, MAX_MENTIONS);

/** The addresses among a body's handles. */
const emailHandlesOf = (body: string) =>
  handlesOf(body).filter((handle) => !handle.startsWith('user:'));

/**
 * A comment as the API shows it. `mentionNames` names each mention by its
 * key and, for a mention written as an address, by that address too (as
 * the body has it, lower-cased); an address nobody resolved gets none.
 */
const view = (
  row: Comment,
  authorName: string | null,
  { names, emails }: Names,
): CommentView => ({
  id: row.id,
  subject: row.subject,
  recordId: row.recordId,
  author: row.author,
  authorName,
  body: row.body,
  mentions: row.mentions,
  mentionNames: Object.fromEntries([
    ...row.mentions.map((key) => [key, names.get(key) ?? null] as const),
    ...emailHandlesOf(row.body).flatMap((address) => {
      const key = emails.get(address);
      return key !== undefined && row.mentions.includes(key)
        ? [[address, names.get(key) ?? null] as const]
        : [];
    }),
  ]),
  editedAt: row.editedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const excerpt = (body: string) =>
  body.length > EXCERPT ? `${body.slice(0, EXCERPT - 1)}…` : body;

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
