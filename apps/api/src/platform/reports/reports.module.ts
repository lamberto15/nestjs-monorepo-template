import { Module, type Provider } from '@nestjs/common';
import { whenOn } from '../switches.js';
import { ReportsService } from './reports.service.js';
import { ReportRunnerJob } from './report-runner.job.js';
import { ReportReadyMail, ReportFailedMail } from './report.mails.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { AccountModule } from '../account/account.module.js';

/**
 * The reports capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [PlatformKernelModule, AccountModule],
  providers: [
    // Scheduled reports: exports run on a schedule, mailed to their recipients.
    ...whenOn<Provider>(
      'REPORTS',
      ReportsService,
      ReportRunnerJob,
      ReportReadyMail,
      ReportFailedMail,
    ),
  ],
  exports: [...whenOn('REPORTS', ReportsService)],
})
export class ReportsModule {}
