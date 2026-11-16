import { Module } from '@nestjs/common';
import { AiModule } from '@nestjs/ai';
import { ConfigService } from '@nestjs/config';
import { AiRegistry } from './ai.registry.js';
import { aiModuleOptions } from './ai-models.js';
import { AiService } from './ai.service.js';
import { AiProcessor } from './ai.processor.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AccountModule } from '../account/account.module.js';
import { AiController } from './ai.controller.js';

/**
 * The ai capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts). Named apart from @nestjs/ai's AiModule, which it imports.
 */
@Module({
  imports: [
    PlatformKernelModule,
    SettingsModule,
    AccountModule,
    // The models of the AI helper: Anthropic, through @nestjs/ai.
    AiModule.forRootAsync({
      inject: [ConfigService],
      useFactory: aiModuleOptions,
    }),
  ],
  controllers: [AiController],
  providers: [
    // The AI helper: features register an AiSource.
    AiRegistry,
    AiService,
    AiProcessor,
  ],
  exports: [AiRegistry, AiService],
})
export class PlatformAiModule {}
