import { Module } from '@nestjs/common';
import { CalendarsService } from './calendars.service.js';
import { CalendarsController } from './calendars.controller.js';

/**
 * The calendars capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  controllers: [CalendarsController],
  providers: [
    // Business calendars: working hours, zone and holidays, and the deadline calculation on them.
    CalendarsService,
  ],
  exports: [CalendarsService],
})
export class CalendarsModule {}
