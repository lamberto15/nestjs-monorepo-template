import { Module } from '@nestjs/common';
import { OpsQueues } from './ops-queues.service.js';
import { OpsBacklog } from './ops-backlog.service.js';
import { DatabaseHealth } from '../../core/database/database-health.js';
import { OpsDiagnostics } from './ops-diagnostics.service.js';
import { OpsMetrics } from './ops-metrics.js';
import { OutboxMetricsReader } from './outbox-metrics.reader.js';
import { OpsPolicy } from './ops.policy.js';
import { OutboxRetentionJob } from './outbox-retention.job.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';

/**
 * The ops capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [PlatformKernelModule],
  providers: [
    OpsQueues,
    OpsBacklog,
    // DatabaseHealth: CoreModule's, stateless; the diagnostics' own instance reads the same pool.
    DatabaseHealth,
    OpsDiagnostics,
    // Queue depths and the outbox on core's /metrics.
    OpsMetrics,
    OutboxMetricsReader,
    OpsPolicy,
    // Outbox dead letters and consumers' inbox records past their retention, nightly (the outbox is always on).
    OutboxRetentionJob,
  ],
  exports: [OpsQueues, OpsBacklog, OpsDiagnostics, OpsPolicy],
})
export class PlatformOpsModule {}
