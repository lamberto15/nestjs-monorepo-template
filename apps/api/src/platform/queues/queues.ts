import { BullModule } from '@nestjs/bullmq';
import { BULK } from '../bulk/bulk.service.js';
import { DATA_TRANSFERS } from '../data-transfer/data-transfer.service.js';
import { MAIL_EVENTS } from '../deliverability/mail-event.types.js';
import { DOCUMENTS } from '../documents/documents.service.js';

/**
 * Every queue the platform keeps (core's mail queue aside): the one list
 * the registration (PlatformModule), the ops view and a tenant's erase
 * (OpsQueues.removeTenantJobs) read, so a new queue can't be left out of
 * any of them.
 */
export const PLATFORM_QUEUES: readonly string[] = [
  DATA_TRANSFERS,
  BULK,
  DOCUMENTS,
  MAIL_EVENTS,
];

/** The platform's queues and the features' own (PlatformModule.forRoot({ queues })). */
export const platformQueues = (featureQueues: readonly string[] = []) => [
  ...PLATFORM_QUEUES,
  ...featureQueues,
];

/**
 * The queues the features declare (PlatformModule.forRoot({ queues })),
 * registered for `@InjectQueue(name)` and the ops view. BullMQ's connection,
 * defaults and workers are core's (core/queues/queues.ts).
 */
export const queues = (names: readonly string[]) =>
  names.length > 0
    ? [BullModule.registerQueue(...names.map((name) => ({ name })))]
    : [];
