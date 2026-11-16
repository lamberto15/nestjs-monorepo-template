import { Module } from '@nestjs/common';
import { AiRegistry } from './ai.registry.js';
import { AiProvider, DisabledAiProvider } from './ai-provider.js';
import { ConfigService } from '@nestjs/config';
import { type PlatformEnv } from '../platform.env.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { AiService } from './ai.service.js';
import { AiProcessor } from './ai.processor.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AccountModule } from '../account/account.module.js';

/**
 * The ai capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [PlatformKernelModule, SettingsModule, AccountModule],
  providers: [
    // The AI helper: features register an AiSource; Anthropic unless another AiProvider is provided.
    AiRegistry,
    {
      provide: AiProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService<PlatformEnv, true>) => {
        const apiKey = config.get('ANTHROPIC_API_KEY', { infer: true });
        return apiKey
          ? new AnthropicProvider({
              apiKey,
              baseURL: config.get('AI_BASE_URL', { infer: true }),
            })
          : new DisabledAiProvider();
      },
    },
    AiService,
    AiProcessor,
  ],
  exports: [AiRegistry, AiProvider, AiService],
})
export class AiModule {}
