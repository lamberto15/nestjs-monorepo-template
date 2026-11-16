import { Module } from '@nestjs/common';
import { SearchRegistry } from './search.registry.js';
import { SearchService } from './search.service.js';

/**
 * The search capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  providers: [
    // Global search: features register a SearchSource.
    SearchRegistry,
    SearchService,
  ],
  exports: [SearchRegistry, SearchService],
})
export class SearchModule {}
