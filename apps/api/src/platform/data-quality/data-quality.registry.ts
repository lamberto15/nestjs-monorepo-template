import { Injectable } from '@nestjs/common';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

/** A table the scan reads: its id, and its recycle bin when it has one. */
export interface QualityTable {
  table: PgTable;
  id: AnyPgColumn;
  /** Set on a soft-deletable table: its deleted rows are not checked, and a reference to one is an error. */
  deletedAt?: AnyPgColumn;
}

/**
 * A subject whose records the data-quality scan checks (docs/data-quality.md):
 * a declared record's comes from its declaration's `quality` and `ref`
 * fields (RecordDataQuality), a hand-written feature registers its own.
 * Register from the constructor: `registry.register(target)`. Data only:
 * the checks are the platform's (DataQualityService), and nothing ever
 * writes to these tables.
 */
export interface DataQualityTarget extends QualityTable {
  /** The records' permission subject: `Note`. Who may read them sees their findings. */
  subject: string;
  /** Fields that should hold a value: empty (null, or blank text) is a suggestion. */
  recommended: Record<string, AnyPgColumn>;
  /** Fields whose value (whatever its case) another record having too makes them duplicate candidates. */
  duplicates: Record<string, AnyPgColumn>;
  /** Reference fields: one pointing at a record in the recycle bin is an error. */
  references: Record<string, { column: AnyPgColumn; to: () => QualityTable }>;
}

@Injectable()
export class DataQualityRegistry {
  private readonly targets = new Map<string, DataQualityTarget>();

  register(target: DataQualityTarget) {
    if (this.targets.has(target.subject)) {
      throw new Error(`Two data-quality targets are for "${target.subject}".`);
    }
    this.targets.set(target.subject, target);
  }

  find(subject: string): DataQualityTarget | undefined {
    return this.targets.get(subject);
  }

  /** Every target, by subject. */
  all(): DataQualityTarget[] {
    return [...this.targets.values()].sort((a, b) =>
      a.subject.localeCompare(b.subject),
    );
  }
}
