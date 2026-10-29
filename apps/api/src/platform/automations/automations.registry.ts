import { Injectable } from '@nestjs/common';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type { List } from '../../core/http/list-query.js';
import type { Principal } from '../../iam/auth/principal.js';

/** A record as rules see it: a row of the subject's table. */
export type AutomationRecord = { id: string } & Record<string, unknown>;

/**
 * A feature whose records rules may be about (the `automation`
 * capability; RecordAutomation for a declared record). Register from the
 * constructor: `automations.register(this)`, and call
 * `AutomationsService.changed()` in the transaction of each create and
 * update. Every check runs as the rule's principal, as they are now.
 */
export interface AutomationTarget {
  /** The records' permission subject: `Note`. */
  readonly subject: string;
  /** Its API path (`notes`): a notification links to `/<path>/{id}`. */
  readonly path: string;
  /** Its table and the columns rules read: the conditions run as SQL on it. */
  readonly table: PgTable;
  readonly columns: { id: AnyPgColumn; updatedAt: AnyPgColumn };
  /** Its list: the conditions are its filters. */
  readonly list: List;
  /** The fields an `updated` trigger may watch. */
  readonly fields: readonly string[];
  /** The fields a `setField` action may set, each with its value's schema. */
  readonly settable: Readonly<Record<string, z.ZodType>>;
  /** Whether the records take tags (`addTag`). */
  readonly tags: boolean;
  /** What a record is called by (its title), as the principal may read it. */
  title(row: AutomationRecord): string;
  /** The record as the API shows it (before redaction). */
  view(row: AutomationRecord): Record<string, unknown>;
  /** Changes the record as the principal, as its PATCH route would. */
  update(
    principal: Principal,
    row: AutomationRecord,
    dto: Record<string, unknown>,
  ): Promise<void>;
}

@Injectable()
export class AutomationsRegistry {
  private readonly targets = new Map<string, AutomationTarget>();

  register(target: AutomationTarget) {
    if (this.targets.has(target.subject)) {
      throw new Error(`Two automation targets are for "${target.subject}".`);
    }
    this.targets.set(target.subject, target);
  }

  /** The registered target of a subject, or undefined. */
  find(subject: string): AutomationTarget | undefined {
    return this.targets.get(subject);
  }

  /** Every target, by subject. */
  all(): AutomationTarget[] {
    return [...this.targets.values()].sort((a, b) =>
      a.subject.localeCompare(b.subject),
    );
  }
}
