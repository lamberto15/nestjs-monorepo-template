/**
 * Every table of the app, for Drizzle's typed queries and for drizzle-kit,
 * which generates the migrations from it (`pnpm db:generate`). Each group
 * keeps its tables next to its code; features list theirs in features/tables.ts.
 */
export * from './core/database/core.tables.js';
export * from './core/tenancy/tenancy.tables.js';
export * from './iam/iam.tables.js';
export * from './platform/idempotency/idempotency.tables.js';
export * from './platform/custom-fields/custom-fields.tables.js';
export * from './platform/notifications/notifications.tables.js';
export * from './platform/settings/settings.tables.js';
export * from './platform/account/account.tables.js';
export * from './platform/subscriptions/subscriptions.tables.js';
export * from './platform/sequences/sequences.tables.js';
export * from './platform/attachments/attachments.tables.js';
export * from './platform/documents/documents.tables.js';
export * from './platform/comments/comments.tables.js';
export * from './platform/tags/tags.tables.js';
export * from './platform/reports/reports.tables.js';
export * from './platform/usage/usage.tables.js';
export * from './platform/revisions/revisions.tables.js';
export * from './platform/approvals/approvals.tables.js';
export * from './platform/money/money.tables.js';
export * from './platform/deliverability/deliverability.tables.js';
export * from './platform/webhooks/webhooks.tables.js';
export * from './platform/webhooks/incoming-senders.tables.js';
// Features
export * from './features/tables.js';
