import { Module } from '@nestjs/common';
import { ChoicesRegistry } from './choices.registry.js';
import { ChoicesService } from './choices.service.js';
import { ChoicesBuiltins } from './choices.builtins.js';
import { ChoicesController } from './choices.controller.js';

/**
 * The choices capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  controllers: [ChoicesController],
  providers: [
    // Dependent dropdowns: server-registered choice providers and the sets that chain them.
    ChoicesRegistry,
    ChoicesService,
    ChoicesBuiltins,
  ],
  exports: [ChoicesRegistry, ChoicesService],
})
export class ChoicesModule {}
