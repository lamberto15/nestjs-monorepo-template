import { Module } from '@nestjs/common';
import { TagsRegistry } from './tags.registry.js';
import { TagsService } from './tags.service.js';
import { TagsController } from './tags.controller.js';

/**
 * The tags capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  controllers: [TagsController],
  providers: [
    // Tags: features register a TagTarget and call TagsService.
    TagsRegistry,
    TagsService,
  ],
  exports: [TagsRegistry, TagsService],
})
export class TagsModule {}
