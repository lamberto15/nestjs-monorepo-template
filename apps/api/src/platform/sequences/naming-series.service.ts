import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, eq, getTableColumns, ne, sql } from 'drizzle-orm';
import type { CoreEnv } from '../../core/config/core.env.js';
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
import { uniqueToConflict } from '../../iam/access/api-clients.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { defineResource } from '../../iam/resources/resource.js';
import {
  counterKey,
  type DateValues,
  dateValues,
  parsePattern,
  patternOf,
  renderPattern,
} from './naming-pattern.js';
import { NAMING_SERIES_LIST } from './naming-series.list.js';
import {
  NamingSeriesRegistry,
  type NumberedSubject,
} from './naming-series.registry.js';
import type {
  CreateNamingSeriesDto,
  NamingCounter,
  NamingSeriesView,
  SetNamingCounterDto,
  UpdateNamingSeriesDto,
} from './naming-series.schemas.js';
import { namingSeries } from './naming-series.tables.js';
import { SequencesService } from './sequences.service.js';

type Series = typeof namingSeries.$inferSelect;

/** Audited as `namingSeries.created`, `.updated` (what changed), `.deleted`; `namingSeries.counterSet`. */
export const NAMING_SERIES = defineResource({
  subject: 'NamingSeries',
  audit: {},
});

const invalid = (path: string, message: string) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors: [{ path, message }],
  });

/** A pattern's counter at a moment: its key in `sequences`, and the declared format's counter it carries on. */
interface Counter {
  name: string;
  key: string;
  carryFrom?: string;
  render: (value: number) => string;
}

/**
 * Naming series (Frappe's): the number formats a tenant's administrators
 * define per numbered subject (`INV-.YYYY.-.MM.-.#####`), one of them the
 * default; a record's create body may name another (`namingSeriesId`).
 * Without any, the format declared in code numbers the subject, as before.
 *
 * The counters are SequencesService's, keyed by what a pattern prints
 * around its counter at the moment (naming-pattern.ts): gapless, locked
 * in the write's transaction, restarting when a date part changes. The
 * declared format's counter carries on into the series that prints the
 * same, so taking it over as a series never gives a number twice.
 */
@Injectable()
export class NamingSeriesService {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly registry: NamingSeriesRegistry,
    private readonly sequences: SequencesService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<CoreEnv, true>,
  ) {}

  /** Registers a numbered subject: from its service's constructor. */
  register(numbered: NumberedSubject) {
    this.registry.register(numbered);
  }

  /** The numbered subjects, with the format each has in code. */
  subjects() {
    return this.registry.all().map(({ subject, declared }) => ({
      subject,
      declaredPattern: patternOf(declared),
    }));
  }

  /**
   * A new record's number, in its transaction: from `seriesId` (a 400 when
   * it is no series of the subject), else the subject's default series,
   * else the declared format.
   */
  async next(
    tx: Transaction,
    subject: string,
    { seriesId, at = new Date() }: { seriesId?: string; at?: Date } = {},
  ) {
    const numbered = this.numbered(subject);
    const [series] = await tx
      .select({ pattern: namingSeries.pattern })
      .from(namingSeries)
      .where(
        and(
          eq(namingSeries.subject, subject),
          seriesId
            ? eq(namingSeries.id, seriesId)
            : eq(namingSeries.isDefault, true),
        ),
      );
    if (seriesId && !series) {
      throw invalid(
        'namingSeriesId',
        `No ${subject} naming series ${seriesId}`,
      );
    }
    const counter = this.counter(
      numbered,
      series?.pattern ?? patternOf(numbered.declared),
      at,
    );
    const value = await this.sequences.take(tx, counter.name, counter.key, {
      carryFrom: counter.carryFrom,
    });
    return { value, formatted: counter.render(value) };
  }

  /** A page of series, newest first unless the query sorts; each with the number it gives next. */
  async list(query: ListQuery) {
    const where = NAMING_SERIES_LIST.where(query);
    const [rows, total] = await Promise.all([
      this.db
        .select({
          ...getTableColumns(namingSeries),
          ...NAMING_SERIES_LIST.sortSelect(query),
        })
        .from(namingSeries)
        .where(and(where, afterCursor(namingSeries.id, query)))
        .orderBy(...pageOrder(namingSeries.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, namingSeries, where, query),
    ]);
    const page = toPage(rows, query, total);
    return { ...page, items: await this.views(page.items) };
  }

  async findOne(id: string): Promise<NamingSeriesView> {
    const [view] = await this.views([await this.row(id)]);
    return view!;
  }

  /** A new series of a numbered subject; a 409 when the subject has the pattern. */
  async create(principal: Principal, dto: CreateNamingSeriesDto, ip?: string) {
    if (!this.registry.find(dto.subject)) {
      throw invalid(
        'subject',
        `"${dto.subject}" takes no number: one of ${this.registry
          .all()
          .map((numbered) => numbered.subject)
          .join(', ')}`,
      );
    }
    const row = await inTransaction(this.txHost, async (tx) => {
      await this.lockSubject(tx, dto.subject);
      const [existing] = await tx
        .select({ id: namingSeries.id })
        .from(namingSeries)
        .where(eq(namingSeries.subject, dto.subject))
        .limit(1);
      // A subject's first series is its default: it takes over from the declared format.
      const isDefault = dto.isDefault === true || !existing;
      if (isDefault) {
        await this.clearDefault(tx, dto.subject);
      }
      const [created] = await tx
        .insert(namingSeries)
        .values({
          subject: dto.subject,
          pattern: dto.pattern,
          label: dto.label || null,
          isDefault,
        })
        .returning();
      await this.audit.recordChange(
        principal,
        NAMING_SERIES,
        { action: 'created', id: created!.id, after: created! },
        tx,
        ip,
      );
      return created!;
    }).catch((error: unknown) => {
      throw uniqueToConflict(error, this.taken(dto.subject, dto.pattern));
    });
    return this.findOne(row.id);
  }

  /** Changes a series' pattern or label, or makes it the default: only what is sent changes. */
  async update(
    principal: Principal,
    id: string,
    dto: UpdateNamingSeriesDto,
    ip?: string,
  ) {
    const series = await this.row(id);
    const values = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as UpdateNamingSeriesDto;
    if (values.label === '') {
      values.label = null;
    }
    if (Object.keys(values).length === 0) {
      return this.findOne(id);
    }
    await inTransaction(this.txHost, async (tx) => {
      await this.lockSubject(tx, series.subject);
      if (values.isDefault) {
        await this.clearDefault(tx, series.subject, id);
      }
      const [updated] = await tx
        .update(namingSeries)
        .set(values)
        .where(eq(namingSeries.id, id))
        .returning();
      await this.audit.recordChange(
        principal,
        NAMING_SERIES,
        { action: 'updated', id, before: series, after: updated! },
        tx,
        ip,
      );
    }).catch((error: unknown) => {
      throw uniqueToConflict(
        error,
        this.taken(series.subject, values.pattern ?? series.pattern),
      );
    });
    return this.findOne(id);
  }

  /**
   * Deletes a series: the numbers it gave stay on their records, and its
   * counter stays (a series printing the same carries on from it). The
   * default's place goes to the oldest series left, or the declared format.
   */
  async remove(principal: Principal, id: string, ip?: string) {
    const series = await this.row(id);
    await inTransaction(this.txHost, async (tx) => {
      await this.lockSubject(tx, series.subject);
      await tx.delete(namingSeries).where(eq(namingSeries.id, id));
      if (series.isDefault) {
        const [oldest] = await tx
          .select({ id: namingSeries.id })
          .from(namingSeries)
          .where(eq(namingSeries.subject, series.subject))
          .orderBy(asc(namingSeries.createdAt), asc(namingSeries.id))
          .limit(1);
        if (oldest) {
          await tx
            .update(namingSeries)
            .set({ isDefault: true })
            .where(eq(namingSeries.id, oldest.id));
        }
      }
      await this.audit.recordChange(
        principal,
        NAMING_SERIES,
        { action: 'deleted', id, before: series },
        tx,
        ip,
      );
    });
  }

  /** A series' counter now: its key, the last value taken, the next number. */
  async counterOf(id: string): Promise<NamingCounter> {
    const series = await this.row(id);
    return this.counterNow(this.numbered(series.subject), series.pattern);
  }

  /** What a pattern would give now, before it is saved (the admin page's preview). */
  async preview(subject: string, pattern: string): Promise<NamingCounter> {
    const numbered = this.registry.find(subject);
    if (!numbered) {
      throw invalid('subject', `"${subject}" takes no number.`);
    }
    return this.counterNow(numbered, pattern);
  }

  /**
   * Starts the series' counter at a value (now's key: this year's, this
   * month's…): the next record gets `current + 1`. A 409 below the last
   * value taken, since a number is never given twice. Audited
   * (`namingSeries.counterSet`, from → to).
   */
  async setCounter(
    principal: Principal,
    id: string,
    { current }: SetNamingCounterDto,
    ip?: string,
  ) {
    const series = await this.row(id);
    const counter = this.counter(
      this.numbered(series.subject),
      series.pattern,
      new Date(),
    );
    await inTransaction(this.txHost, async (tx) => {
      const { set, before } = await this.sequences.setAtLeast(
        tx,
        counter.name,
        counter.key,
        current,
        { carryFrom: counter.carryFrom },
      );
      if (!set) {
        throw new ConflictException(
          `${counter.render(before)} is taken: the counter can't go below ${before}.`,
        );
      }
      await this.audit.record(
        principal,
        {
          action: 'namingSeries.counterSet',
          targetType: 'namingSeries',
          targetId: id,
          details: { key: counter.key, from: before, to: current },
          ip,
        },
        tx,
      );
    });
    return this.counterOf(id);
  }

  private numbered(subject: string) {
    const numbered = this.registry.find(subject);
    if (!numbered) {
      throw new Error(
        `"${subject}" is not numbered: register it with NamingSeriesService.`,
      );
    }
    return numbered;
  }

  private async row(id: string): Promise<Series> {
    const [series] = await this.db
      .select()
      .from(namingSeries)
      .where(eq(namingSeries.id, id));
    if (!series) {
      throw new NotFoundException(`Naming series ${id} not found.`);
    }
    return series;
  }

  /** Rows as the API shows them, each with its next number (one query for the counters). */
  private async views(rows: Series[]): Promise<NamingSeriesView[]> {
    const at = new Date();
    const counters = rows.map((row) =>
      this.counter(
        // A series left by a feature since removed still lists.
        this.registry.find(row.subject) ?? {
          subject: row.subject,
          sequence: row.subject.charAt(0).toLowerCase() + row.subject.slice(1),
          declared: {},
        },
        row.pattern,
        at,
      ),
    );
    const values = await this.sequences.peekMany(counters);
    return rows.map((row, index) => ({
      id: row.id,
      subject: row.subject,
      pattern: row.pattern,
      label: row.label,
      isDefault: row.isDefault,
      example: counters[index]!.render(values[index]! + 1),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  private async counterNow(numbered: NumberedSubject, pattern: string) {
    const counter = this.counter(numbered, pattern, new Date());
    const current = await this.sequences.peek(counter.name, counter.key, {
      carryFrom: counter.carryFrom,
    });
    return { key: counter.key, current, next: counter.render(current + 1) };
  }

  /**
   * A pattern's counter at a moment. When it prints what the declared
   * format prints, it carries on from the declared format's counter (its
   * `sequences` scope from before naming series: `|<year>`, or `|`).
   */
  private counter(
    numbered: NumberedSubject,
    pattern: string,
    at: Date,
  ): Counter {
    const date = this.dateOf(at);
    const parts = parsePattern(pattern);
    const key = counterKey(parts, date);
    const declaredKey = counterKey(
      parsePattern(patternOf(numbered.declared)),
      date,
    );
    return {
      name: numbered.sequence,
      key,
      ...(key === declaredKey && {
        carryFrom: `|${numbered.declared.perYear ? date.YYYY : ''}`,
      }),
      render: (value) => renderPattern(parts, value, date),
    };
  }

  private dateOf(at: Date): DateValues {
    return dateValues(at, this.config.get('APP_TIMEZONE', { infer: true }));
  }

  /** One change of a subject's series at a time: the default stays one. */
  private async lockSubject(tx: Transaction, subject: string) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`naming-series:${subject}`}))`,
    );
  }

  private async clearDefault(
    tx: Transaction,
    subject: string,
    except?: string,
  ) {
    await tx
      .update(namingSeries)
      .set({ isDefault: false })
      .where(
        and(
          eq(namingSeries.subject, subject),
          eq(namingSeries.isDefault, true),
          except ? ne(namingSeries.id, except) : undefined,
        ),
      );
  }

  private taken(subject: string, pattern: string) {
    return `${subject} has a naming series ${pattern}.`;
  }
}
