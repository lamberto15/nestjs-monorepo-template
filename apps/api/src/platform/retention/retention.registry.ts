import { Injectable } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

/**
 * How long a kind of record is kept, declared next to the feature that owns
 * it. Register from the constructor: `retention.register({ … })`.
 *
 * ```ts
 * retention.register({
 *   name: 'note',
 *   label: 'Notes',
 *   subject: 'Note',
 *   table: notes,
 *   ageColumn: notes.createdAt,
 *   action: 'purge',
 *   defaultDays: 730,
 *   minDays: 30,
 * });
 * ```
 *
 * A rule does nothing until a tenant turns it on (`PUT /v1/retention/rules/{name}`,
 * `Access.manageRetention`); the tenant may then choose its days, not below
 * `minDays`. The nightly job (RetentionScheduler) queues the work on the
 * `retention` queue; records under a legal hold are never touched.
 */
export interface RetentionRule {
  /** Unique; the route's key: `note`. */
  readonly name: string;
  /** Shown to the administrator: `Notes`. */
  readonly label: string;
  /** The records' permission subject, what a legal hold names: `Note`. */
  readonly subject: string;
  /** The tenant table (it needs `id` and `tenantId`). */
  readonly table: PgTable & { id: AnyPgColumn };
  /** How old a record is: the column that dates it. */
  readonly ageColumn: AnyPgColumn;
  /**
   * `purge` deletes the rows (and what refers to them: RecordPurgeRegistry);
   * `anonymise` keeps the rows and overwrites what identifies a person.
   */
  readonly action: 'purge' | 'anonymise';
  /** The days a tenant starts from when it turns the rule on. */
  readonly defaultDays: number;
  /** The shortest a tenant may set (default 1). */
  readonly minDays?: number;
  /** Only these rows are ever due (a closed record, say). */
  readonly where?: SQL;
  /**
   * `anonymise` only: the values written (`{ email: null, name: 'Anonymised' }`)
   * and the condition of a row not yet written (`isNotNull(table.email)`), so
   * a row is anonymised once.
   */
  readonly anonymise?: {
    readonly set: Record<string, unknown>;
    readonly pending: SQL;
  };
}

@Injectable()
export class RetentionRegistry {
  private readonly rules = new Map<string, RetentionRule>();

  register(rule: RetentionRule) {
    if (this.rules.has(rule.name)) {
      throw new Error(`Two retention rules are named "${rule.name}".`);
    }
    if (rule.action === 'anonymise' && !rule.anonymise) {
      throw new Error(
        `The retention rule "${rule.name}" anonymises: declare what it writes (anonymise: { set, pending }).`,
      );
    }
    if (rule.defaultDays < (rule.minDays ?? 1)) {
      throw new Error(
        `The retention rule "${rule.name}" starts below its minimum.`,
      );
    }
    this.rules.set(rule.name, rule);
  }

  all() {
    return [...this.rules.values()];
  }

  find(name: string) {
    return this.rules.get(name);
  }
}
