import { Module } from '@nestjs/common';
import { SequencesService } from './sequences.service.js';
import { NamingSeriesRegistry } from './naming-series.registry.js';
import { NamingVariables } from './naming-variables.js';
import { NamingSeriesService } from './naming-series.service.js';
import { SettingsModule } from '../settings/settings.module.js';

/**
 * The sequences capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [SettingsModule],
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
