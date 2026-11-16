import { Module } from '@nestjs/common';
import { CalendarsService } from './calendars.service.js';

/**
 * The calendars capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  providers: [
    // Business calendars: working hours, zone and holidays, and the deadline calculation on them.
    CalendarsService,
  ],
  exports: [CalendarsService],
})
export class CalendarsModule {}
