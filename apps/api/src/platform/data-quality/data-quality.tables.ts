import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';

/** What a finding says is wrong with a record's field (docs/data-quality.md). */
export const QUALITY_CHECKS = ['missing', 'reference', 'duplicate'] as const;
export type QualityCheck = (typeof QUALITY_CHECKS)[number];
/** An error is wrong (a reference to a deleted record); a suggestion may be right as it is. */
export const QUALITY_SEVERITIES = ['error', 'suggestion'] as const;
export type QualitySeverity = (typeof QUALITY_SEVERITIES)[number];

/**
 * One problem the data-quality scan found on one field of one record: there
 * while it holds (a scan or a recheck that no longer finds it deletes it),
 * dismissed by someone who decided it is right as it is (and stays so while
 * it holds). Nothing here ever changes the record.
 */
export const dataQualityFindings = pgTable(
  'data_quality_findings',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    check: text('check').$type<QualityCheck>().notNull(),
    /** The record's field it is about. */
    field: text('field').notNull(),
    severity: text('severity').$type<QualitySeverity>().notNull(),
    /** What helps to act on it: the record referred to, the other record with the same value. */
    detail: jsonb('detail').$type<Record<string, string>>(),
    /** When a scan or a recheck last found it. */
    checkedAt: at('checked_at').notNull().defaultNow(),
    dismissedAt: at('dismissed_at'),
    /** `user:<id>` of who dismissed it. */
    dismissedBy: text('dismissed_by'),
    ...timestamps(),
  },
  (table) => [
    ...tenantTable('data_quality_findings', table),
    uniqueIndex('data_quality_findings_key_idx').on(
      table.tenantId,
      table.subject,
      table.recordId,
      table.check,
      table.field,
    ),
  ],
).enableRLS();

export type DataQualityFindingRow = typeof dataQualityFindings.$inferSelect;

/** A scan of the tenant's records, its progress and how it ended. */
export const dataQualityScans = pgTable(
  'data_quality_scans',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    status: text('status')
      .$type<'queued' | 'running' | 'completed' | 'failed'>()
      .notNull()
      .default('queued'),
    /** The records to check when it started, and those checked so far. */
    total: integer('total').notNull().default(0),
    scanned: integer('scanned').notNull().default(0),
    /** Open findings once it completed. */
    findings: integer('findings'),
    /** `user:<id>` or `client:<id>` of who started it. */
    startedBy: text('started_by').notNull(),
    finishedAt: at('finished_at'),
    ...timestamps(),
  },
  (table) => [
    ...tenantTable('data_quality_scans', table),
    index('data_quality_scans_tenant_idx').on(table.tenantId, table.createdAt),
  ],
).enableRLS();

export type DataQualityScanRow = typeof dataQualityScans.$inferSelect;
