import { Module } from '@nestjs/common';
import { RecordSchedulesService } from './record-schedules.service.js';
import { RecordScheduleRunnerJob } from './record-schedule-runner.job.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { AccountModule } from '../account/account.module.js';
import { CalendarsModule } from '../calendars/calendars.module.js';
import { RecordSchedulesController } from './record-schedules.controller.js';

/**
 * The recurrence capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [PlatformKernelModule, AccountModule, CalendarsModule],
  controllers: [RecordSchedulesController],
  providers: [
    // Recurring record schedules: records created from a template at each occurrence of a rule.
    RecordSchedulesService,
    RecordScheduleRunnerJob,
  ],
  exports: [RecordSchedulesService],
})
export class RecurrenceModule {}
