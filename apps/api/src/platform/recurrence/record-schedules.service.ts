import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, count, eq, sql } from 'drizzle-orm';
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
import { tenantKey } from '../../core/tenancy/tenant-scope.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  principalKey,
  type RequestPrincipal,
  type SystemPrincipal,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { defineResource } from '../../iam/resources/resource.js';
import {
  PersonalDataRegistry,
  type PersonalDataSource,
} from '../account/personal-data.registry.js';
import type { BusinessCalendarRow } from '../calendars/calendars.tables.js';
import { CalendarsService } from '../calendars/calendars.service.js';
import { DataTransferRegistry } from '../data-transfer/data-transfer.registry.js';
import { stillActive } from '../queues/still-active.js';
import {
  type CreateRecordScheduleDto,
  MAX_ACTIVE_SCHEDULES,
  type PreviewRecordScheduleDto,
  type UpdateRecordScheduleDto,
} from './record-schedule.schemas.js';
import { RECORD_SCHEDULE_LIST } from './record-schedule.list.js';
import {
  type RecordScheduleRow,
  recordScheduleRuns,
  recordSchedules,
} from './record-schedules.tables.js';
import {
  nextOccurrence,
  parseRule,
  type RecurrenceSchedule,
} from './recurrence-rule.js';

/** Audited as `recordSchedule.created`, `.updated` (what changed), `.deleted`; the runner's `.ran`, `.skipped`, `.ended`. */
export const RECORD_SCHEDULE = defineResource({
  subject: 'RecordSchedule',
  audit: {},
});

/** An occurrence that fails this many times (a pass every five minutes) is skipped. */
export const MAX_ATTEMPTS = 3;

const view = (row: RecordScheduleRow) => ({
  id: row.id,
  name: row.name,
  importer: row.importer,
  template: row.template,
  rrule: row.rrule,
  startDate: row.startDate,
  time: row.time,
  timezone: row.timezone,
  calendarId: row.calendarId,
  status: row.status,
  endReason: row.endReason,
  occurrences: row.occurrences,
  maxOccurrences: row.maxOccurrences,
  failures: row.failures,
  lastError: row.lastError,
  lastRunAt: row.lastRunAt?.toISOString() ?? null,
  lastStatus: row.lastStatus,
  nextRunAt: row.nextRunAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const invalid = (errors: { path: string; message: string }[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors,
  });

/** What a runner pass did with one schedule. */
export type RunOutcome = 'created' | 'skipped' | 'failed' | 'ended' | 'idle';

/**
 * Recurring record schedules: a template (a row of a data importer) that
 * creates a record, as its owner, at each occurrence of an RRULE-style
 * rule on the wall clock of a time zone, optionally moved into a business
 * calendar's working time. Each principal sees and changes only their own.
 * The runner (`RecordScheduleRunnerJob`) calls `runDue()`; an occurrence
 * is created once however often it is tried (see there).
 */
@Injectable()
export class RecordSchedulesService implements PersonalDataSource {
  private readonly logger = new Logger('RecordSchedules');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly registry: DataTransferRegistry,
    private readonly calendars: CalendarsService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly users: UsersRepository,
    private readonly config: ConfigService<CoreEnv, true>,
    personalData: PersonalDataRegistry,
  ) {
    personalData.register(this);
  }

  /** As a personal data source: the person's schedules are in their export… */
  readonly name = 'recordSchedule';
  async *rows(user: UserPrincipal) {
    const rows = await this.db
      .select()
      .from(recordSchedules)
      .where(eq(recordSchedules.owner, principalKey(user)));
    if (rows.length) yield rows.map(view);
  }

  /** …and go with their account (what they would create is theirs to give). */
  async erase(tx: Transaction, user: UserPrincipal) {
    await tx
      .delete(recordSchedules)
      .where(eq(recordSchedules.owner, principalKey(user)));
  }

  async page(principal: RequestPrincipal, query: ListQuery) {
    const where = and(
      eq(recordSchedules.owner, principalKey(principal)),
      RECORD_SCHEDULE_LIST.where(query),
    );
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(recordSchedules)
        .where(and(where, afterCursor(recordSchedules.id, query)))
        .orderBy(...pageOrder(recordSchedules.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, recordSchedules, where, query),
    ]);
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map(view) };
  }

  async get(principal: RequestPrincipal, id: string) {
    return view(await this.findOwn(principal, id));
  }

  /** The next moments records would be created, from now. */
  async preview(dto: PreviewRecordScheduleDto, principal: RequestPrincipal) {
    const calendar = await this.calendar(dto.calendarId);
    const schedule = this.schedule(principal, dto);
    const rule = parseRule(dto.rrule);
    const occurrences: string[] = [];
    let after = new Date();
    while (occurrences.length < Math.min(dto.count, rule.count ?? dto.count)) {
      const next = this.nextRun(schedule, calendar, after);
      if (!next) break;
      occurrences.push(next.toISOString());
      after = next;
    }
    return { occurrences };
  }

  async create(
    principal: RequestPrincipal,
    dto: CreateRecordScheduleDto,
    ip?: string,
  ) {
    this.notImpersonating(principal);
    await this.check(principal, dto.importer, dto.template);
    const calendar = await this.calendar(dto.calendarId);
    const timezone = this.zone(principal, dto.timezone);
    const rule = parseRule(dto.rrule);
    const next = this.nextRun(
      { rule, startDate: dto.startDate, time: dto.time, timezone },
      calendar,
      new Date(),
    );
    if (!next) {
      throw invalid([
        { path: 'rrule', message: 'It has no occurrence to come.' },
      ]);
    }
    const row = await inTransaction(this.txHost, async (tx) => {
      await this.assertRoomFor(principal);
      const [created] = await tx
        .insert(recordSchedules)
        .values({
          owner: principalKey(principal),
          name: dto.name,
          importer: dto.importer,
          template: dto.template,
          rrule: dto.rrule,
          startDate: dto.startDate,
          time: dto.time,
          timezone,
          calendarId: dto.calendarId ?? null,
          maxOccurrences: rule.count,
          nextRunAt: next,
        })
        .returning();
      await this.audit.recordChange(
        principal,
        RECORD_SCHEDULE,
        { action: 'created', id: created!.id, after: created! },
        tx,
        ip,
      );
      return created!;
    });
    return view(row);
  }

  /**
   * Only what is sent changes; an active schedule's next run is computed
   * again from now when its rule, start, time, zone or calendar changes.
   */
  async update(
    principal: RequestPrincipal,
    id: string,
    dto: UpdateRecordScheduleDto,
    ip?: string,
  ) {
    this.notImpersonating(principal);
    const before = await this.findOwn(principal, id);
    this.notEnded(before);
    const values = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as UpdateRecordScheduleDto;
    if (Object.keys(values).length === 0) {
      return view(before);
    }
    if (values.template !== undefined) {
      await this.check(principal, before.importer, values.template);
    }
    const merged = { ...before, ...values };
    const calendar = await this.calendar(merged.calendarId ?? undefined);
    const rule = parseRule(merged.rrule);
    const timing = ['rrule', 'startDate', 'time', 'timezone', 'calendarId'];
    const retime = timing.some((key) => key in values);
    let nextRunAt = before.nextRunAt;
    if (retime && before.status === 'active') {
      nextRunAt = this.nextRun(
        {
          rule,
          startDate: merged.startDate,
          time: merged.time,
          timezone: merged.timezone,
        },
        calendar,
        new Date(),
      );
      if (!nextRunAt) {
        throw invalid([
          { path: 'rrule', message: 'It has no occurrence to come.' },
        ]);
      }
    }
    const row = await inTransaction(this.txHost, async (tx) => {
      const [updated] = await tx
        .update(recordSchedules)
        .set({
          ...values,
          maxOccurrences: rule.count,
          nextRunAt,
          ...(retime && { failures: 0, lastError: null }),
        })
        .where(eq(recordSchedules.id, id))
        .returning();
      await this.audit.recordChange(
        principal,
        RECORD_SCHEDULE,
        { action: 'updated', id, before, after: updated! },
        tx,
        ip,
      );
      return updated!;
    });
    return view(row);
  }

  async remove(principal: RequestPrincipal, id: string, ip?: string) {
    const before = await this.findOwn(principal, id);
    await inTransaction(this.txHost, async (tx) => {
      await tx.delete(recordSchedules).where(eq(recordSchedules.id, id));
      await this.audit.recordChange(
        principal,
        RECORD_SCHEDULE,
        { action: 'deleted', id, before },
        tx,
        ip,
      );
    });
  }

  /** Stops creating until resumed; the occurrences in between are not made up. */
  async pause(principal: RequestPrincipal, id: string, ip?: string) {
    const before = await this.findOwn(principal, id);
    this.notEnded(before);
    if (before.status === 'paused') return view(before);
    return this.setStatus(principal, before, 'paused', { nextRunAt: null }, ip);
  }

  /** Picks up at the next occurrence after now. */
  async resume(principal: RequestPrincipal, id: string, ip?: string) {
    this.notImpersonating(principal);
    const before = await this.findOwn(principal, id);
    this.notEnded(before);
    if (before.status === 'active') return view(before);
    const next = this.nextRun(
      this.scheduleOf(before),
      await this.calendar(before.calendarId ?? undefined),
      new Date(),
    );
    if (!next) {
      return this.setStatus(
        principal,
        before,
        'ended',
        { nextRunAt: null, endReason: 'completed' },
        ip,
      );
    }
    await this.assertRoomFor(principal);
    return this.setStatus(
      principal,
      before,
      'active',
      { nextRunAt: next, failures: 0, lastError: null },
      ip,
    );
  }

  /** Ends it for good; the records it made stay. */
  async end(principal: RequestPrincipal, id: string, ip?: string) {
    const before = await this.findOwn(principal, id);
    if (before.status === 'ended') return view(before);
    return this.setStatus(
      principal,
      before,
      'ended',
      { nextRunAt: null, endReason: 'ended' },
      ip,
    );
  }

  /**
   * Creates the record of the schedule's due occurrence, if there is one,
   * and moves the schedule to the next. Safe to call again and from many
   * workers at once:
   *
   * - one transaction holds the schedule row (`FOR UPDATE SKIP LOCKED`: a
   *   second worker finds it taken and does nothing);
   * - the occurrence's moment is inserted into `record_schedule_runs`
   *   (unique per schedule and moment) before the record is written, so
   *   not even a schedule reset to an earlier moment can create it twice;
   * - the record, that row and the move to the next occurrence commit
   *   together or not at all, so a crash or an error leaves the occurrence
   *   due, to be tried again.
   *
   * The owner is looked up again (an inactive one ends the schedule), and
   * may still import the kind of record; the template is checked again as
   * the importer's schema is now. Failures are counted: the third in a row
   * skips the occurrence (`skipped` in the runs) and goes on to the next.
   */
  async runDue(
    id: string,
    now: Date,
    system: SystemPrincipal,
  ): Promise<RunOutcome> {
    let due: RecordScheduleRow | undefined;
    try {
      return await inTransaction(this.txHost, async (tx) => {
        const [row] = await tx
          .select()
          .from(recordSchedules)
          .where(eq(recordSchedules.id, id))
          .for('update', { skipLocked: true });
        if (
          !row ||
          row.status !== 'active' ||
          !row.nextRunAt ||
          row.nextRunAt > now
        ) {
          return 'idle';
        }
        due = row;
        const owner = await this.owner(row, tx);
        if (!owner) return this.stop(tx, row, 'owner_inactive', system);
        const importer = this.registry.importer(row.importer);
        if (
          !importer ||
          !(await this.access.can(
            owner,
            importer.action ?? 'create',
            importer.subject,
          ))
        ) {
          return this.stop(tx, row, 'import_not_allowed', system);
        }
        const parsed = (
          importer.schemaFor ? await importer.schemaFor(owner) : importer.schema
        ).safeParse(row.template);
        if (!parsed.success)
          return this.stop(tx, row, 'template_invalid', system);
        const [claimed] = await tx
          .insert(recordScheduleRuns)
          .values({
            scheduleId: row.id,
            occurrenceAt: row.nextRunAt,
            status: 'created',
          })
          .onConflictDoNothing()
          .returning({ id: recordScheduleRuns.id });
        if (claimed) {
          await importer.write(owner, parsed.data);
          await this.audit.record(
            system,
            {
              action: 'recordSchedule.ran',
              targetType: 'recordSchedule',
              targetId: row.id,
              details: {
                occurrence: row.nextRunAt.toISOString(),
                importer: row.importer,
              },
            },
            tx,
          );
        }
        await this.advance(tx, row, now, { lastStatus: 'created' });
        return 'created';
      });
    } catch (error) {
      if (!due) throw error; // before there was anything to run: not ours to hide
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('A recurring record could not be created', {
        schedule: id,
        error: message,
      });
      return this.fail(id, due, now, message, system);
    }
  }

  /** Counts a failed attempt at `due`'s occurrence; the last allowed skips it. */
  private fail(
    id: string,
    due: RecordScheduleRow,
    now: Date,
    message: string,
    system: SystemPrincipal,
  ) {
    return inTransaction(this.txHost, async (tx): Promise<RunOutcome> => {
      const [row] = await tx
        .select()
        .from(recordSchedules)
        .where(eq(recordSchedules.id, id))
        .for('update');
      // Changed, paused or taken meanwhile: that attempt is not this one's to count.
      if (
        !row ||
        row.status !== 'active' ||
        row.nextRunAt?.getTime() !== due.nextRunAt?.getTime()
      ) {
        return 'idle';
      }
      const error = message.slice(0, 500);
      const failures = row.failures + 1;
      if (failures < MAX_ATTEMPTS) {
        await tx
          .update(recordSchedules)
          .set({
            failures,
            lastError: error,
            lastStatus: 'failed',
            lastRunAt: now,
          })
          .where(eq(recordSchedules.id, id));
        return 'failed';
      }
      await tx
        .insert(recordScheduleRuns)
        .values({
          scheduleId: id,
          occurrenceAt: row.nextRunAt!,
          status: 'skipped',
          error,
        })
        .onConflictDoNothing();
      await this.audit.record(
        system,
        {
          action: 'recordSchedule.skipped',
          targetType: 'recordSchedule',
          targetId: id,
          details: { occurrence: row.nextRunAt!.toISOString(), error },
        },
        tx,
      );
      await this.advance(tx, row, now, {
        lastStatus: 'failed',
        lastError: error,
      });
      return 'skipped';
    });
  }

  /** Counts the handled occurrence and moves to the next, or ends the schedule. */
  private async advance(
    tx: Transaction,
    row: RecordScheduleRow,
    now: Date,
    result: { lastStatus: 'created' | 'failed'; lastError?: string },
  ) {
    const occurrences = row.occurrences + 1;
    const next =
      row.maxOccurrences !== null && occurrences >= row.maxOccurrences
        ? null
        : this.nextRun(
            this.scheduleOf(row),
            await this.calendar(row.calendarId ?? undefined),
            row.nextRunAt!,
          );
    await tx
      .update(recordSchedules)
      .set({
        occurrences,
        failures: 0,
        lastRunAt: now,
        lastStatus: result.lastStatus,
        lastError: result.lastError ?? null,
        nextRunAt: next,
        ...(!next && { status: 'ended', endReason: 'completed' }),
      })
      .where(eq(recordSchedules.id, row.id));
  }

  /** Ends a schedule that can no longer run, and says why. */
  private async stop(
    tx: Transaction,
    row: RecordScheduleRow,
    reason: string,
    system: SystemPrincipal,
  ): Promise<RunOutcome> {
    await tx
      .update(recordSchedules)
      .set({ status: 'ended', endReason: reason, nextRunAt: null })
      .where(eq(recordSchedules.id, row.id));
    await this.audit.record(
      system,
      {
        action: 'recordSchedule.ended',
        targetType: 'recordSchedule',
        targetId: row.id,
        details: { owner: row.owner, reason },
      },
      tx,
    );
    return 'ended';
  }

  /** The owner as they are now, acting in the schedule's tenant; null when they no longer can. */
  private owner(row: RecordScheduleRow, tx: Transaction) {
    const [kind, id] = row.owner.split(':') as [string, string];
    if (kind !== 'user' && kind !== 'client') return null;
    return stillActive(
      { kind, id, tenantId: row.tenantId } as RequestPrincipal,
      this.users,
      tx,
    );
  }

  private scheduleOf(row: RecordScheduleRow): RecurrenceSchedule {
    return {
      rule: parseRule(row.rrule),
      startDate: row.startDate,
      time: row.time,
      timezone: row.timezone,
    };
  }

  private schedule(
    principal: RequestPrincipal,
    dto: { rrule: string; startDate: string; time: string; timezone?: string },
  ): RecurrenceSchedule {
    return {
      rule: parseRule(dto.rrule),
      startDate: dto.startDate,
      time: dto.time,
      timezone: this.zone(principal, dto.timezone),
    };
  }

  private zone(principal: RequestPrincipal, timezone?: string) {
    return (
      timezone ??
      (principal.kind === 'user' ? principal.timezone : null) ??
      this.config.get('APP_TIMEZONE', { infer: true })
    );
  }

  /**
   * The occurrence after `after`, moved into the calendar's working time
   * when there is one. Strictly after, so occurrences that land on one
   * working moment make one record.
   */
  private nextRun(
    schedule: RecurrenceSchedule,
    calendar: BusinessCalendarRow | null,
    after: Date,
  ) {
    const next = nextOccurrence(schedule, after);
    return next && calendar
      ? this.calendars.addWorkingMinutes(calendar, next, 0)
      : next;
  }

  private async calendar(id?: string) {
    if (!id) return null;
    try {
      return await this.calendars.row(id);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw invalid([{ path: 'calendarId', message: 'No such calendar.' }]);
      }
      throw error;
    }
  }

  /** A schedule creates records later, unobserved: never for an impersonated user. */
  private notImpersonating(principal: RequestPrincipal) {
    if (principal.kind === 'user' && principal.impersonator) {
      throw new ForbiddenException(
        'A session impersonating a user cannot set up recurring records.',
      );
    }
  }

  private notEnded(row: RecordScheduleRow) {
    if (row.status === 'ended') {
      throw new ConflictException('The schedule has ended.');
    }
  }

  /** The importer exists, the principal may import into it, and the template is one of its rows. */
  private async check(
    principal: RequestPrincipal,
    importerName: string,
    template: Record<string, unknown>,
  ) {
    const importer = this.registry.importer(importerName);
    const action = importer?.action ?? 'create';
    if (
      !importer ||
      !(await this.access.can(principal, action, importer.subject))
    ) {
      throw invalid([
        {
          path: 'importer',
          message: `No import named "${importerName}" you may run (GET /v1/data lists yours).`,
        },
      ]);
    }
    const parsed = (
      importer.schemaFor ? await importer.schemaFor(principal) : importer.schema
    ).safeParse(template);
    if (!parsed.success) {
      throw invalid(
        parsed.error.issues.map((issue) => ({
          path: ['template', ...issue.path].join('.'),
          message: issue.message,
        })),
      );
    }
    const forbidden = await this.access.forbiddenFields(
      principal,
      action,
      importer.subject,
      template,
    );
    if (forbidden.length > 0) {
      throw new ForbiddenException({
        code: 'field_forbidden',
        message: `Your permissions do not let you set: ${forbidden.join(', ')}.`,
        fields: forbidden,
      });
    }
  }

  /** A 400 when the principal has MAX_ACTIVE_SCHEDULES active schedules already. */
  private async assertRoomFor(principal: RequestPrincipal) {
    // One count at a time per owner (in the caller's transaction): two
    // creates at once can't both take the last place.
    await this.db.execute(
      sql`select pg_advisory_xact_lock(hashtext(${tenantKey(`record-schedules:${principalKey(principal)}`)}))`,
    );
    const [row] = await this.db
      .select({ active: count() })
      .from(recordSchedules)
      .where(
        and(
          eq(recordSchedules.owner, principalKey(principal)),
          eq(recordSchedules.status, 'active'),
        ),
      );
    if ((row?.active ?? 0) >= MAX_ACTIVE_SCHEDULES) {
      throw invalid([
        {
          path: 'status',
          message: `At most ${MAX_ACTIVE_SCHEDULES} active schedules: pause or end one first.`,
        },
      ]);
    }
  }

  private async setStatus(
    principal: RequestPrincipal,
    before: RecordScheduleRow,
    status: RecordScheduleRow['status'],
    set: Partial<RecordScheduleRow>,
    ip?: string,
  ) {
    const row = await inTransaction(this.txHost, async (tx) => {
      const [updated] = await tx
        .update(recordSchedules)
        .set({ status, ...set })
        .where(eq(recordSchedules.id, before.id))
        .returning();
      await this.audit.recordChange(
        principal,
        RECORD_SCHEDULE,
        { action: 'updated', id: before.id, before, after: updated! },
        tx,
        ip,
      );
      return updated!;
    });
    return view(row);
  }

  private async findOwn(principal: RequestPrincipal, id: string) {
    const [row] = await this.db
      .select()
      .from(recordSchedules)
      .where(
        and(
          eq(recordSchedules.id, id),
          eq(recordSchedules.owner, principalKey(principal)),
        ),
      );
    if (!row) {
      throw new NotFoundException(`Recurring schedule ${id} not found.`);
    }
    return row;
  }
}
