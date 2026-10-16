import { BullModule } from '@nestjs/bullmq';

/**
 * The queues the features declare (PlatformModule.forRoot({ queues })),
 * registered for `@InjectQueue(name)` and the ops view. BullMQ's connection,
 * defaults and workers are core's (core/queues/queues.ts).
 */
export const queues = (names: readonly string[]) =>
  names.length > 0
    ? [BullModule.registerQueue(...names.map((name) => ({ name })))]
    : [];
