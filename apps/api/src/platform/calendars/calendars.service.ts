import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { asc, count, eq } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { uniqueToConflict } from '../../iam/access/api-clients.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { defineResource } from '../../iam/resources/resource.js';
import { recordSchedules } from '../recurrence/record-schedules.tables.js';
import {
  addWorkingMinutes,
  type CalendarDefinition,
  NoWorkingTimeError,
} from './calendar-time.js';
import {
  type CreateCalendarDto,
  MAX_CALENDARS,
  type UpdateCalendarDto,
} from './calendar.schemas.js';
import {
  type BusinessCalendarRow,
  businessCalendars,
} from './calendars.tables.js';

/** Audited as `businessCalendar.created`, `.updated` (what changed, the version too), `.deleted`. */
export const BUSINESS_CALENDAR = defineResource({
  subject: 'BusinessCalendar',
  audit: {},
});

/** JSON with sorted keys: jsonb returns an object's keys in its own order. */
const stable = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );

const view = (row: BusinessCalendarRow) => ({
  id: row.id,
  name: row.name,
  timezone: row.timezone,
  hours: row.hours,
  exceptions: row.exceptions,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Business calendars: the working hours, time zone and holidays of a
 * tenant, and the one deadline calculation everything that counts working
 * time shares (`deadline()`; the math is calendar-time.ts). Any change to
 * what moves a deadline bumps the calendar's `version`; a deadline already
 * computed is not touched (docs/i18n-and-time.md, "Business calendars").
 */
@Injectable()
export class CalendarsService {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.db
      .select()
      .from(businessCalendars)
      .orderBy(asc(businessCalendars.name))
      .limit(MAX_CALENDARS);
    return { items: rows.map(view) };
  }

  async findOne(id: string) {
    return view(await this.row(id));
  }

  /** The calendar of the current tenant, for deadline math; 404 when it is none of the tenant's. */
  async row(id: string) {
    const [row] = await this.db
      .select()
      .from(businessCalendars)
      .where(eq(businessCalendars.id, id));
    if (!row) {
      throw new NotFoundException(`Calendar ${id} not found.`);
    }
    return row;
  }

  async create(principal: Principal, dto: CreateCalendarDto, ip?: string) {
    const row = await inTransaction(this.txHost, async (tx) => {
      const [{ total } = { total: 0 }] = await tx
        .select({ total: count() })
        .from(businessCalendars);
      if (total >= MAX_CALENDARS) {
        throw new BadRequestException({
          code: 'validation_failed',
          message: `At most ${MAX_CALENDARS} calendars.`,
        });
      }
      const [created] = await tx
        .insert(businessCalendars)
        .values(dto)
        .returning();
      await this.audit.recordChange(
        principal,
        BUSINESS_CALENDAR,
        { action: 'created', id: created!.id, after: created! },
        tx,
        ip,
      );
      return created!;
    }).catch((error: unknown) => {
      throw uniqueToConflict(error, `A calendar is named "${dto.name}".`);
    });
    return view(row);
  }

  /**
   * Only what is sent changes. A change of hours, zone or exceptions makes
   * the next version; a rename does not.
   */
  async update(
    principal: Principal,
    id: string,
    dto: UpdateCalendarDto,
    ip?: string,
  ) {
    const before = await this.row(id);
    const values = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as UpdateCalendarDto;
    const moves = (['timezone', 'hours', 'exceptions'] as const).some(
      (key) =>
        values[key] !== undefined &&
        stable(values[key]) !== stable(before[key]),
    );
    if (Object.keys(values).length === 0) {
      return view(before);
    }
    const row = await inTransaction(this.txHost, async (tx) => {
      const [updated] = await tx
        .update(businessCalendars)
        .set({ ...values, ...(moves && { version: before.version + 1 }) })
        .where(eq(businessCalendars.id, id))
        .returning();
      await this.audit.recordChange(
        principal,
        BUSINESS_CALENDAR,
        { action: 'updated', id, before, after: updated! },
        tx,
        ip,
      );
      return updated!;
    }).catch((error: unknown) => {
      throw uniqueToConflict(error, `A calendar is named "${dto.name}".`);
    });
    return view(row);
  }

  /** Refused while a recurring schedule follows it. */
  async remove(principal: Principal, id: string, ip?: string) {
    const before = await this.row(id);
    await inTransaction(this.txHost, async (tx) => {
      const [{ used } = { used: 0 }] = await tx
        .select({ used: count() })
        .from(recordSchedules)
        .where(eq(recordSchedules.calendarId, id));
      if (used > 0) {
        throw new ConflictException(
          `${used} recurring schedule(s) follow this calendar.`,
        );
      }
      await tx.delete(businessCalendars).where(eq(businessCalendars.id, id));
      await this.audit.recordChange(
        principal,
        BUSINESS_CALENDAR,
        { action: 'deleted', id, before },
        tx,
        ip,
      );
    });
  }

  /**
   * The reusable deadline calculation: `minutes` of working time after
   * `from` (0: the first working moment at or after it), with the
   * calendar's version, for the caller to store beside the deadline.
   */
  async deadline(id: string, from: Date, minutes: number) {
    const calendar = await this.row(id);
    return {
      due: this.addWorkingMinutes(calendar, from, minutes).toISOString(),
      calendarVersion: calendar.version,
    };
  }

  /** The math on a row already in hand; a calendar with no working time is a 400. */
  addWorkingMinutes(calendar: CalendarDefinition, from: Date, minutes: number) {
    try {
      return addWorkingMinutes(calendar, from, minutes);
    } catch (error) {
      if (error instanceof NoWorkingTimeError) {
        throw new BadRequestException({
          code: 'calendar_has_no_working_time',
          message: error.message,
        });
      }
      throw error;
    }
  }
}
