import { Module } from '@nestjs/common';
import { TagsRegistry } from './tags.registry.js';
import { TagsService } from './tags.service.js';

/**
 * The tags capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  providers: [
    // Tags: features register a TagTarget and call TagsService.
    TagsRegistry,
    TagsService,
  ],
  exports: [TagsRegistry, TagsService],
})
export class TagsModule {}
