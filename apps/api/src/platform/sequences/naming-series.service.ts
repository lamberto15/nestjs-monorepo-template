import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, desc, eq, getTableColumns, ne, sql } from 'drizzle-orm';
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
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { uniqueToConflict } from '../../iam/access/api-clients.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { defineResource } from '../../iam/resources/resource.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  counterKey,
  type DateValues,
  dateValues,
  namesIn,
  type PartValues,
  parsePattern,
  PatternError,
  type PatternNames,
  type PatternPart,
  patternOf,
  printValue,
  renderPattern,
} from './naming-pattern.js';
import { NAMING_SERIES_LIST } from './naming-series.list.js';
import {
  NamingSeriesRegistry,
  type NumberedSubject,
  type NumberingFieldKind,
} from './naming-series.registry.js';
import type {
  CreateNamingSeriesDto,
  NamingCounter,
  NamingSeriesView,
  PreviewNamingSeriesDto,
  SetNamingCounterDto,
  UpdateNamingSeriesDto,
} from './naming-series.schemas.js';
import { type NamingCondition, namingSeries } from './naming-series.tables.js';
import {
  type NamingContext,
  type NamingVariable,
  NamingVariables,
} from './naming-variables.js';
import {
  NUMBERING_ABBREVIATION,
  NUMBERING_FISCAL_YEAR_START,
} from './numbering-settings.js';
import { SequencesService } from './sequences.service.js';

type Series = typeof namingSeries.$inferSelect;

/** What numbers a record: a series' pattern and date field, or the declared format's. */
type Format = Pick<Series, 'pattern' | 'dateField'>;

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

/** A pattern's counter for a record at a moment: its key in `sequences`, and the declared format's counter it carries on. */
interface Counter {
  name: string;
  key: string;
  carryFrom?: string;
  render: (value: number) => string;
}

/**
 * How a counter is worked out. `strict`: for a record's number, a field or
 * variable printing nothing is a 400 at `path(field)`; otherwise (lists,
 * previews) it prints as `{field}`.
 */
interface CounterOptions {
  at: Date;
  values: Readonly<Record<string, unknown>>;
  strict?: { path: (name: string) => string };
}

/**
 * Naming series (Frappe's): the number formats a tenant's administrators
 * define per numbered subject (`INV-.YYYY.-.{customer}.-.#####`), one of
 * them the default; a record's create body may name another
 * (`namingSeriesId`), and a series with conditions numbers the records
 * they hold for (Frappe's Document Naming Rule). Without any, the format
 * declared in code numbers the subject, as before.
 *
 * A pattern prints dates (now's, or the record's date field's), variables
 * (FY, ABBR, and the ones features declare: naming-variables.ts) and the
 * record's own fields. The counters are SequencesService's, keyed by what
 * a pattern prints around its counter for the record (naming-pattern.ts):
 * gapless, locked in the write's transaction, restarting when a date part
 * changes, one per value of a field it prints. The declared format's
 * counter carries on into the series that prints the same, so taking it
 * over as a series never gives a number twice.
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
    private readonly variables: NamingVariables,
    private readonly sequences: SequencesService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<CoreEnv, true>,
    private readonly settings: SettingsService,
    private readonly tenancy: Tenancy,
  ) {
    // ERPNext's two, as settings of the tenant's (numbering-settings.ts).
    variables.declare({
      name: 'FY',
      description:
        'The fiscal year of the date: 2026, or 2026-2027 when it starts after January (numbering.fiscalYearStart).',
      resolve: async ({ date }) => {
        const start = await this.settings.get(NUMBERING_FISCAL_YEAR_START);
        const year = Number(date.YYYY);
        if (start === 1) {
          return date.YYYY;
        }
        const first = Number(date.MM) >= start ? year : year - 1;
        return `${first}-${first + 1}`;
      },
    });
    variables.declare({
      name: 'ABBR',
      description:
        "The tenant's abbreviation (numbering.abbreviation), else its slug in capitals.",
      resolve: async () => {
        const abbreviation = await this.settings.get(NUMBERING_ABBREVIATION);
        if (abbreviation) {
          return abbreviation;
        }
        const tenantId = this.tenancy.current()?.tenantId;
        const tenant = tenantId ? await this.tenancy.find(tenantId) : undefined;
        return tenant?.slug.toUpperCase() ?? '';
      },
    });
  }

  /** Registers a numbered subject: from its service's constructor. */
  register(numbered: NumberedSubject) {
    this.registry.register(numbered);
  }

  /** Declares a variable every pattern may print (`.REGION.`): from a feature's constructor. */
  declareVariable(variable: NamingVariable) {
    this.variables.declare(variable);
  }

  /** The numbered subjects, with the format each has in code and the fields its series may read. */
  subjects() {
    return this.registry.all().map(({ subject, declared, fields = {} }) => ({
      subject,
      declaredPattern: patternOf(declared),
      fields: Object.entries(fields).map(([name, kind]) => ({ name, kind })),
    }));
  }

  /** The variables patterns may print. */
  variableList() {
    return this.variables
      .all()
      .map(({ name, description }) => ({ name, description }));
  }

  /**
   * A new record's number, in its transaction, from its create body's
   * `values`: in `seriesId` (a 400 when it is no series of the subject),
   * else the first series by priority whose conditions hold for the
   * record, else the subject's default series, else the declared format.
   * A field or variable the pattern prints with no value is a 400.
   */
  async next(
    tx: Transaction,
    subject: string,
    {
      seriesId,
      values = {},
      at = new Date(),
    }: {
      seriesId?: string;
      values?: Readonly<Record<string, unknown>>;
      at?: Date;
    } = {},
  ) {
    const numbered = this.numbered(subject);
    const series = seriesId
      ? await this.named(tx, subject, seriesId)
      : await this.chosen(tx, numbered, values);
    const counter = await this.counter(
      numbered,
      series ?? { pattern: patternOf(numbered.declared), dateField: null },
      { at, values, strict: { path: (name) => name } },
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
    const numbered = this.registry.find(dto.subject);
    if (!numbered) {
      throw invalid(
        'subject',
        `"${dto.subject}" takes no number: one of ${this.registry
          .all()
          .map((known) => known.subject)
          .join(', ')}`,
      );
    }
    this.check(numbered, dto);
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
          dateField: dto.dateField ?? null,
          conditions: dto.conditions ?? [],
          priority: dto.priority ?? 0,
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

  /** Changes a series' pattern, label, date field, conditions or priority, or makes it the default: only what is sent changes. */
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
    const numbered = this.registry.find(series.subject);
    if (numbered) {
      this.check(numbered, {
        pattern: values.pattern ?? series.pattern,
        dateField:
          values.dateField === undefined ? series.dateField : values.dateField,
        conditions: values.conditions ?? series.conditions,
      });
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
   * counters stay (a series printing the same carries on from them). The
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

  /** A series' counter now: its key, the last value taken, the next number (the fields it prints as `{field}`). */
  async counterOf(id: string): Promise<NamingCounter> {
    const series = await this.row(id);
    return this.counterNow(this.numbered(series.subject), series, {});
  }

  /**
   * What a pattern would give now, before it is saved (the admin page's
   * preview), for a record with `values`: its fields left out print as
   * `{field}`.
   */
  async preview(dto: PreviewNamingSeriesDto): Promise<NamingCounter> {
    const numbered = this.registry.find(dto.subject);
    if (!numbered) {
      throw invalid('subject', `"${dto.subject}" takes no number.`);
    }
    this.check(numbered, { pattern: dto.pattern, dateField: dto.dateField });
    return this.counterNow(
      numbered,
      { pattern: dto.pattern, dateField: dto.dateField ?? null },
      dto.values ?? {},
    );
  }

  /**
   * Starts the series' counter at a value (now's key: this year's, this
   * month's…, and with fields in the pattern, the key of `values`): the
   * next record gets `current + 1`. A 409 below the last value taken,
   * since a number is never given twice. Audited
   * (`namingSeries.counterSet`, from → to).
   */
  async setCounter(
    principal: Principal,
    id: string,
    { current, values = {} }: SetNamingCounterDto,
    ip?: string,
  ) {
    const series = await this.row(id);
    const counter = await this.counter(this.numbered(series.subject), series, {
      at: new Date(),
      values,
      strict: { path: (name) => `values.${name}` },
    });
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
    return this.counterNow(this.numbered(series.subject), series, values);
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

  /** The series a body names: a 400 when it is no series of the subject. */
  private async named(tx: Transaction, subject: string, seriesId: string) {
    const [series] = await tx
      .select()
      .from(namingSeries)
      .where(
        and(eq(namingSeries.subject, subject), eq(namingSeries.id, seriesId)),
      );
    if (!series) {
      throw invalid(
        'namingSeriesId',
        `No ${subject} naming series ${seriesId}`,
      );
    }
    return series;
  }

  /**
   * The series for a record whose body names none: the first, by
   * priority (then the oldest), whose conditions all hold for it; else
   * the default. Undefined: the declared format.
   */
  private async chosen(
    tx: Transaction,
    numbered: NumberedSubject,
    values: Readonly<Record<string, unknown>>,
  ) {
    const rows = await tx
      .select()
      .from(namingSeries)
      .where(eq(namingSeries.subject, numbered.subject))
      .orderBy(
        desc(namingSeries.priority),
        asc(namingSeries.createdAt),
        asc(namingSeries.id),
      );
    const fields = numbered.fields ?? {};
    return (
      rows.find(
        (row) =>
          row.conditions.length > 0 &&
          row.conditions.every((condition) =>
            holds(condition, fields[condition.field], values[condition.field]),
          ),
      ) ?? rows.find((row) => row.isDefault)
    );
  }

  /** Rows as the API shows them, each with its next number (one query for the counters). */
  private async views(rows: Series[]): Promise<NamingSeriesView[]> {
    const at = new Date();
    const counters = await Promise.all(
      rows.map((row) =>
        this.counter(
          // A series left by a feature since removed still lists.
          this.registry.find(row.subject) ?? {
            subject: row.subject,
            sequence:
              row.subject.charAt(0).toLowerCase() + row.subject.slice(1),
            declared: {},
          },
          row,
          { at, values: {} },
        ),
      ),
    );
    const values = await this.sequences.peekMany(counters);
    return rows.map((row, index) => ({
      id: row.id,
      subject: row.subject,
      pattern: row.pattern,
      label: row.label,
      isDefault: row.isDefault,
      dateField: row.dateField,
      conditions: row.conditions,
      priority: row.priority,
      example: counters[index]!.render(values[index]! + 1),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  private async counterNow(
    numbered: NumberedSubject,
    format: Format,
    values: Readonly<Record<string, unknown>>,
  ) {
    const counter = await this.counter(numbered, format, {
      at: new Date(),
      values,
    });
    const current = await this.sequences.peek(counter.name, counter.key, {
      carryFrom: counter.carryFrom,
    });
    return { key: counter.key, current, next: counter.render(current + 1) };
  }

  /** The names a subject's patterns may use: its fields (not booleans) and the variables. */
  private names(numbered: NumberedSubject): PatternNames {
    return {
      fields: new Set(
        Object.entries(numbered.fields ?? {})
          .filter(([, kind]) => kind !== 'boolean')
          .map(([name]) => name),
      ),
      variables: this.variables.names(),
    };
  }

  /** A series' pattern, date field and conditions, checked against its subject: a 400 at the part that is wrong. */
  private check(
    numbered: NumberedSubject,
    {
      pattern,
      dateField,
      conditions = [],
    }: {
      pattern: string;
      dateField?: string | null;
      conditions?: NamingCondition[];
    },
  ) {
    try {
      parsePattern(pattern, this.names(numbered));
    } catch (error) {
      if (error instanceof PatternError) {
        throw invalid('pattern', error.message);
      }
      throw error;
    }
    const fields = numbered.fields ?? {};
    const of = (kinds: NumberingFieldKind[]) =>
      Object.entries(fields)
        .filter(([, kind]) => kinds.includes(kind))
        .map(([name]) => name);
    if (dateField) {
      const dates = of(['date', 'datetime']);
      if (!dates.includes(dateField)) {
        throw invalid(
          'dateField',
          `"${dateField}" is no date field of ${numbered.subject}: ${dates.join(', ') || 'it has none'}.`,
        );
      }
    }
    conditions.forEach((condition, index) => {
      const kind = fields[condition.field];
      if (!kind) {
        throw invalid(
          `conditions.${index}.field`,
          `"${condition.field}" is no field of ${numbered.subject}: ${Object.keys(fields).join(', ') || 'it has none'}.`,
        );
      }
      const type =
        kind === 'number'
          ? 'number'
          : kind === 'boolean'
            ? 'boolean'
            : 'string';
      if (typeof condition.value !== type) {
        throw invalid(
          `conditions.${index}.value`,
          `${condition.field} is a ${kind} field: the value is a ${type}.`,
        );
      }
      if (kind === 'boolean' && !['eq', 'ne'].includes(condition.op)) {
        throw invalid(
          `conditions.${index}.op`,
          `${condition.field} is a yes/no field: eq or ne.`,
        );
      }
    });
  }

  /**
   * A pattern's counter for a record at a moment. When it prints what the
   * declared format prints, it carries on from the declared format's
   * counter (its `sequences` scope from before naming series: `|<year>`,
   * or `|`).
   */
  private async counter(
    numbered: NumberedSubject,
    { pattern, dateField }: Format,
    { at, values, strict }: CounterOptions,
  ): Promise<Counter> {
    const parts = parsePattern(pattern, this.names(numbered));
    const when = this.dateOf(numbered, dateField, values) ?? at;
    const date = this.datesAt(when);
    const printedValues: PartValues = {
      date,
      fields: this.fieldsOf(numbered, parts, values, strict),
      variables: await this.variablesOf(
        parts,
        { subject: numbered.subject, at: when, date, values },
        strict,
      ),
    };
    const key = counterKey(parts, printedValues);
    const declaredKey = counterKey(parsePattern(patternOf(numbered.declared)), {
      date,
    });
    return {
      name: numbered.sequence,
      key,
      ...(key === declaredKey && {
        carryFrom: `|${numbered.declared.perYear ? date.YYYY : ''}`,
      }),
      render: (value) => renderPattern(parts, value, printedValues),
    };
  }

  /** The record's fields a pattern prints, as they print (a datetime as its date in the app's zone). */
  private fieldsOf(
    numbered: NumberedSubject,
    parts: PatternPart[],
    values: Readonly<Record<string, unknown>>,
    strict: CounterOptions['strict'],
  ) {
    const printed: Record<string, string> = {};
    for (const name of namesIn(parts).fields) {
      const raw = values[name];
      const value =
        numbered.fields?.[name] === 'datetime' && typeof raw === 'string'
          ? isoDate(this.datesAt(new Date(raw)))
          : printValue(raw);
      if (value !== undefined) {
        printed[name] = value;
      } else if (strict) {
        throw invalid(
          strict.path(name),
          `The number's format prints ${name}: the record needs a value of letters or digits.`,
        );
      }
    }
    return printed;
  }

  /** The variables a pattern prints, for the record; one that throws or prints nothing is a 400 when strict. */
  private async variablesOf(
    parts: PatternPart[],
    context: NamingContext,
    strict: CounterOptions['strict'],
  ) {
    const printed: Record<string, string> = {};
    for (const name of namesIn(parts).variables) {
      const variable = this.variables.find(name)!;
      let value: string | undefined;
      try {
        value = printValue(await variable.resolve(context));
      } catch (error) {
        if (strict) {
          throw error;
        }
      }
      if (value !== undefined) {
        printed[name] = value;
      } else if (strict) {
        throw invalid(
          'namingSeriesId',
          `The number's format prints ${name}, which has no value for this record.`,
        );
      }
    }
    return printed;
  }

  /** The moment of the record's date field, when the series takes its dates from one and the record has it. */
  private dateOf(
    numbered: NumberedSubject,
    dateField: string | null,
    values: Readonly<Record<string, unknown>>,
  ): Date | undefined {
    const raw = dateField ? values[dateField] : undefined;
    if (typeof raw !== 'string') {
      return undefined;
    }
    // A date is a calendar day: read in the app's zone, at noon, it stays that day.
    const at =
      numbered.fields?.[dateField!] === 'date' &&
      /^\d{4}-\d{2}-\d{2}$/.test(raw)
        ? this.noonOf(raw)
        : new Date(raw);
    return Number.isNaN(at.getTime()) ? undefined : at;
  }

  /** Noon of a calendar day in the app's zone. */
  private noonOf(day: string) {
    const noonUtc = new Date(`${day}T12:00:00Z`);
    // Shift by the zone's offset at that time, so the day in the zone is `day`.
    const inZone = this.datesAt(noonUtc);
    const shift =
      Date.parse(`${isoDate(inZone)}T12:00:00Z`) - noonUtc.getTime();
    return new Date(noonUtc.getTime() - shift);
  }

  private datesAt(at: Date): DateValues {
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

/** `2026-10-20`. */
function isoDate(date: DateValues) {
  return `${date.YYYY}-${date.MM}-${date.DD}`;
}

/**
 * Whether a condition holds for a create body's value: numbers compared as
 * numbers, dates and text as text (ISO dates sort as text). A value the
 * body leaves out meets only `ne`.
 */
export function holds(
  { op, value }: NamingCondition,
  kind: NumberingFieldKind | undefined,
  raw: unknown,
) {
  if (raw === undefined || raw === null || kind === undefined) {
    return op === 'ne';
  }
  const [left, right] =
    kind === 'number'
      ? [Number(raw), Number(value)]
      : kind === 'boolean'
        ? [raw === true ? 1 : 0, value === true ? 1 : 0]
        : [String(raw as string | number), String(value)];
  switch (op) {
    case 'eq':
      return left === right;
    case 'ne':
      return left !== right;
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
  }
}
