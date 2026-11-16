import { Module } from '@nestjs/common';
import { SequencesService } from './sequences.service.js';
import { NamingSeriesRegistry } from './naming-series.registry.js';
import { NamingVariables } from './naming-variables.js';
import { NamingSeriesService } from './naming-series.service.js';
import { SettingsModule } from '../settings/settings.module.js';
import { NamingSeriesController } from './naming-series.controller.js';

/**
 * The sequences capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [SettingsModule],
  controllers: [NamingSeriesController],
  providers: [
    // Gapless human-readable numbers, taken in a write's transaction.
    SequencesService,
    // Naming series: numbered features register and take numbers through it.
    NamingSeriesRegistry,
    NamingVariables,
    NamingSeriesService,
  ],
  exports: [SequencesService, NamingSeriesService],
})
export class SequencesModule {}
