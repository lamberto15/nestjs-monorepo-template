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
    'Deletes the files and rows of attachments whose record no longer exists, and the files of direct uploads that were never completed, every night.',
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

/** RecentsRetentionJob: old recently opened records. */
export const RECENTS_RETENTION_JOB = defineSystemJob({
  key: 'recents-retention',
  label: 'Recent records retention',
  description:
    'Deletes recently opened records older than 30 days, every night.',
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
 * RecordScheduleRunnerJob: creates the records of the recurring schedules
 * that are due (each as the schedule's owner, with the owner's
 * permissions), ends the ones that can no longer run, skips an occurrence
 * that fails for good.
 */
export const RECORD_SCHEDULE_JOB = defineSystemJob({
  key: 'record-schedules',
  label: 'Recurring record schedules',
  description:
    'Creates the records of the recurring schedules that are due (as their owners), ends the schedules that can no longer run, and records the occurrences it skips.',
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

/** OutboxRetentionJob: dead letters and inbox records older than OUTBOX_*_RETENTION_DAYS. */
export const OUTBOX_RETENTION_JOB = defineSystemJob({
  key: 'outbox-retention',
  label: 'Outbox retention',
  description:
    "Deletes outbox dead letters older than OUTBOX_DEAD_LETTER_RETENTION_DAYS and consumers' inbox records older than OUTBOX_INBOX_RETENTION_DAYS, every night.",
  permissions: [],
});

/** PlatformAnalyticsJob: the anonymized aggregates of analytics.platform_metrics. */
export const PLATFORM_ANALYTICS_JOB = defineSystemJob({
  key: 'platform-analytics',
  label: 'Platform analytics',
  description:
    'Counts tenants, users, memberships and API use across every tenant, withholds small groups, and stores only the aggregates the reporting role reads, every night.',
  permissions: [],
});

/** ReencryptionScheduler and ReencryptionProcessor: encrypted columns onto the current keys. */
export const REENCRYPTION_JOB = defineSystemJob({
  key: 'reencryption',
  label: 'Re-encryption',
  description:
    'Rewrites encrypted values and blind indexes still under an older key with the current one, in batches, every hour.',
  permissions: [],
});

/** RetentionScheduler and RetentionProcessor: records past their tenant's retention rules. */
export const RETENTION_JOB = defineSystemJob({
  key: 'retention',
  label: 'Retention',
  description:
    'Purges or anonymises the records past the retention rules a tenant turned on, in batches, skipping records under a legal hold, every night.',
  permissions: [],
});

/** MessagingProcessor: the SMS and push the notification channels queued. */
export const MESSAGING_JOB = defineSystemJob({
  key: 'messaging',
  label: 'Push and SMS delivery',
  description:
    'Sends the SMS and push messages notifications queued, within the toll-fraud caps.',
  permissions: [],
});

/** MessagingService: STOP and START arriving from the SMS provider. */
export const MESSAGING_INBOUND_JOB = defineSystemJob({
  key: 'messaging-inbound',
  label: 'Inbound SMS',
  description:
    'Records a number opting out (STOP) or back in (START) from the SMS provider webhook.',
  permissions: [],
});

/** MessagingRetentionJob: stale devices and old cap counters. */
export const MESSAGING_RETENTION_JOB = defineSystemJob({
  key: 'messaging-retention',
  label: 'Messaging retention',
  description:
    'Removes devices not seen for DEVICES_RETENTION_DAYS and the toll-fraud counters of past days, every night.',
  permissions: [],
});

/** AttachmentScanService: the malware scan of an upload, on a worker. */
export const ATTACHMENT_SCAN_JOB = defineSystemJob({
  key: 'attachment-scan',
  label: 'Attachment malware scan',
  description:
    'Scans uploaded files for malware (MALWARE_SCANNER) and removes the infected ones.',
  permissions: [],
});

/** AttachmentImagesService: thumbnails, previews and metadata stripping of an uploaded image, on a worker. */
export const ATTACHMENT_IMAGES_JOB = defineSystemJob({
  key: 'attachment-images',
  label: 'Attachment image processing',
  description:
    'Makes thumbnails and previews of uploaded images and removes the metadata (EXIF, GPS) of the originals.',
  permissions: [],
});

/** AttachmentTextService: the text of an uploaded file, for the search inside attachments, on a worker. */
export const ATTACHMENT_TEXT_JOB = defineSystemJob({
  key: 'attachment-text',
  label: 'Attachment text extraction',
  description:
    'Extracts the text of uploaded documents (ATTACHMENT_TEXT_SEARCH) so that the search finds them.',
  permissions: [],
});

export const PLATFORM_SYSTEM_JOBS = [
  ACCOUNT_DELETION_JOB,
  USAGE_ROLLUP_JOB,
  ATTACHMENT_SWEEP_JOB,
  ATTACHMENT_SCAN_JOB,
  ATTACHMENT_IMAGES_JOB,
  ATTACHMENT_TEXT_JOB,
  REVISION_RETENTION_JOB,
  NOTIFICATION_RETENTION_JOB,
  RECENTS_RETENTION_JOB,
  NOTIFICATION_DIGEST_JOB,
  NOTIFICATION_DELIVERY_JOB,
  REPORT_RUNNER_JOB,
  RECORD_SCHEDULE_JOB,
  APPROVALS_JOB,
  EXCHANGE_RATES_JOB,
  MAIL_INTAKE_JOB,
  MAIL_EVENTS_RETENTION_JOB,
  WEBHOOK_DELIVERY_RETENTION_JOB,
  OUTBOX_RETENTION_JOB,
  PLATFORM_ANALYTICS_JOB,
  REENCRYPTION_JOB,
  RETENTION_JOB,
  MESSAGING_JOB,
  MESSAGING_INBOUND_JOB,
  MESSAGING_RETENTION_JOB,
];
