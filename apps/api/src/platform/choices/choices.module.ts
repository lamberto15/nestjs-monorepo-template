import { Module } from '@nestjs/common';
import { ChoicesRegistry } from './choices.registry.js';
import { ChoicesService } from './choices.service.js';
import { ChoicesBuiltins } from './choices.builtins.js';

/**
 * The choices capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  providers: [
    // Dependent dropdowns: server-registered choice providers and the sets that chain them.
    ChoicesRegistry,
    ChoicesService,
    ChoicesBuiltins,
  ],
  exports: [ChoicesRegistry, ChoicesService],
})
export class ChoicesModule {}
