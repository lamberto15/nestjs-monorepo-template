import { Module } from '@nestjs/common';
import { SearchRegistry } from './search.registry.js';
import { SearchService } from './search.service.js';
import { SearchController } from './search.controller.js';

/**
 * The search capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  controllers: [SearchController],
  providers: [
    // Global search: features register a SearchSource.
    SearchRegistry,
    SearchService,
  ],
  exports: [SearchRegistry, SearchService],
})
export class SearchModule {}
