import { Module } from '@nestjs/common';
import { FeaturesService } from './features.service.js';
import { ModeModule } from '../mode/mode.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { PlatformAiModule } from '../ai/ai.module.js';

/**
 * The features capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [ModeModule, DocumentsModule, PlatformAiModule],
  providers: [
    // Which switches are on, for clients (GET /v1/features).
    FeaturesService,
  ],
  exports: [FeaturesService],
})
export class PlatformFeaturesModule {}
