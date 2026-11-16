import { Module } from '@nestjs/common';
import { FeaturesService } from './features.service.js';
import { ModeModule } from '../mode/mode.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { PlatformAiModule } from '../ai/ai.module.js';
import { FeaturesController } from './features.controller.js';

/**
 * The features capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [ModeModule, DocumentsModule, PlatformAiModule],
  controllers: [FeaturesController],
  providers: [
    // Which switches are on, for clients (GET /v1/features).
    FeaturesService,
  ],
  exports: [FeaturesService],
})
export class PlatformFeaturesModule {}
