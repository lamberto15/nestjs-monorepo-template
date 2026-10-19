import { defineSystemJob } from '../iam/access/permissions.js';

/**
 * The platform's work without a user, as the system principal
 * (docs/permissions.md, "The system principal"), listed in
 * PLATFORM_PERMISSIONS. `permissions: []`: the job checks none (it keeps
 * its own tables), so a service it calls that does check refuses it; a
 * permission nothing checks would only advertise a grant in the catalog.
 */

/** AccountDeletionJob: accounts whose grace period passed. */
export const ACCOUNT_DELETION_JOB = defineSystemJob({
  key: 'account-deletion',
  label: 'Account deletion',
  description:
    'Anonymizes the accounts whose deletion grace period passed, and erases their personal data, every night.',
  permissions: [],
});

/** UsageRollupJob: API clients' daily counters into api_usage. */
export const USAGE_ROLLUP_JOB = defineSystemJob({
  key: 'usage-rollup',
  label: 'Usage roll-up',
  description:
    "Copies API clients' daily usage counters from Redis into the database, every night.",
  permissions: [],
});

/** AttachmentSweepJob: attachments of records deleted for good. */
export const ATTACHMENT_SWEEP_JOB = defineSystemJob({
  key: 'attachment-sweep',
  label: 'Attachment sweep',
  description:
    'Deletes the files and rows of attachments whose record no longer exists, every night.',
  permissions: [],
});

/** RevisionRetentionJob: revisions older than REVISIONS_RETENTION_DAYS. */
export const REVISION_RETENTION_JOB = defineSystemJob({
  key: 'revisions-retention',
  label: 'Revision retention',
  description:
    "Deletes record revisions older than REVISIONS_RETENTION_DAYS (never a record's latest), every night.",
  permissions: [],
});

/** NotificationRetentionJob: old notifications. */
export const NOTIFICATION_RETENTION_JOB = defineSystemJob({
  key: 'notification-retention',
  label: 'Notification retention',
  description:
    'Deletes read notifications past NOTIFICATIONS_RETENTION_DAYS and any past NOTIFICATIONS_MAX_AGE_DAYS, every night.',
  permissions: [],
});

/** NotificationDigestJob: the digests that are due. */
export const NOTIFICATION_DIGEST_JOB = defineSystemJob({
  key: 'notification-digests',
  label: 'Notification digests',
  description: 'Mails the notification digests that are due, every hour.',
  permissions: [],
});

/** NotificationDeliveryHandler: the outbox relay hands it each stored notification. */
export const NOTIFICATION_DELIVERY_JOB = defineSystemJob({
  key: 'notification-delivery',
  label: 'Notification delivery',
  description:
    'Delivers stored notifications through their channels (realtime, mail, webhook), from the outbox.',
  permissions: [],
});

/**
 * ReportRunnerJob and the end of a report's export: starts the reports
 * that are due (each export runs as the report's owner, with the owner's
 * permissions), pauses the ones that can't run, records how each ended.
 */
export const REPORT_RUNNER_JOB = defineSystemJob({
  key: 'report-runner',
  label: 'Scheduled reports',
  description:
    'Starts the scheduled reports that are due (as their owners), pauses the ones that can no longer run, and records how each run ended.',
  permissions: [],
});

/**
 * ApprovalWorkflow's steps: starting stages, reminders, escalations,
 * expiry, and the outcome handlers (which act as it: `outcome.actor`).
 */
export const APPROVALS_JOB = defineSystemJob({
  key: 'approvals',
  label: 'Approvals',
  description:
    "Runs approval requests' workflows: starts stages, reminds, escalates, expires, and applies the outcome.",
  permissions: [],
});

/** ExchangeRatesJob: the ECB's reference rates, into exchange_rates. */
export const EXCHANGE_RATES_JOB = defineSystemJob({
  key: 'exchange-rates',
  label: 'Exchange rates',
  description:
    "Fetches the ECB's euro reference rates once they are published each working day, and stores them.",
  permissions: [],
});

/**
 * MailEventsProcessor: the bounces and complaints a mail provider reported
 * (platform/deliverability), into the suppression list.
 */
export const MAIL_INTAKE_JOB = defineSystemJob({
  key: 'mail-intake',
  label: 'Mail intake',
  description:
    'Records the bounces and complaints a mail provider reports (SES through SNS) and keeps the suppression list from them.',
  permissions: [],
});

/** MailEventsRetentionJob: events older than MAIL_EVENTS_RETENTION_DAYS. */
export const MAIL_EVENTS_RETENTION_JOB = defineSystemJob({
  key: 'mail-events-retention',
  label: 'Mail events retention',
  description:
    'Deletes bounce, complaint and delivery events older than MAIL_EVENTS_RETENTION_DAYS, every night.',
  permissions: [],
});

/** WebhookDeliveryRetentionJob: finished deliveries older than WEBHOOKS_DELIVERY_RETENTION_DAYS. */
export const WEBHOOK_DELIVERY_RETENTION_JOB = defineSystemJob({
  key: 'webhook-delivery-retention',
  label: 'Webhook delivery retention',
  description:
    'Deletes outgoing webhook deliveries that finished more than WEBHOOKS_DELIVERY_RETENTION_DAYS ago, with their attempt log and recorded requests (never one still being retried), every night.',
  permissions: [],
});

export const PLATFORM_SYSTEM_JOBS = [
  ACCOUNT_DELETION_JOB,
  USAGE_ROLLUP_JOB,
  ATTACHMENT_SWEEP_JOB,
  REVISION_RETENTION_JOB,
  NOTIFICATION_RETENTION_JOB,
  NOTIFICATION_DIGEST_JOB,
  NOTIFICATION_DELIVERY_JOB,
  REPORT_RUNNER_JOB,
  APPROVALS_JOB,
  EXCHANGE_RATES_JOB,
  MAIL_INTAKE_JOB,
  MAIL_EVENTS_RETENTION_JOB,
  WEBHOOK_DELIVERY_RETENTION_JOB,
];
