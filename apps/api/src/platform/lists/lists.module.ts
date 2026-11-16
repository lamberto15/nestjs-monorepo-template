import { Module } from '@nestjs/common';
import { ListsRegistry } from './lists.registry.js';
import { ListsService } from './lists.service.js';
import { ListPolicy } from './list.policy.js';
import { AccessListSources } from './access-lists.js';
import { TenantListSource } from './tenant-lists.js';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';

/**
 * The lists capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [CustomFieldsModule, DocumentsModule, ApprovalsModule],
  providers: [
    // Lists described at runtime (GET /v1/lists/{subject}): features register their list.
    ListsRegistry,
    ListsService,
    ListPolicy,
    // The access API's users and audit lists (GET /v1/lists/User, /Audit).
    AccessListSources,
    // The operators' tenants list (GET /v1/lists/Tenant).
    TenantListSource,
  ],
  exports: [ListsRegistry, ListsService],
})
export class ListsModule {}
