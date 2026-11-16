import { Module } from '@nestjs/common';
import { DocumentsRegistry } from './documents.registry.js';
import { DocumentTemplates } from './document-templates.js';
import { PdfRenderer, gotenbergClient } from './pdf-renderer.js';
import { DocumentsService } from './documents.service.js';
import { DocumentsProcessor } from './documents.processor.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { PeopleModule } from '../people/people.module.js';
import { AccountModule } from '../account/account.module.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { BrandingModule } from '../branding/branding.module.js';

/**
 * The documents capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [
    // Gotenberg, which renders the PDF documents (GOTENBERG_URL).
    gotenbergClient(),
    PlatformKernelModule,
    PeopleModule,
    AccountModule,
    AttachmentsModule,
    BrandingModule,
  ],
  providers: [
    // PDF documents of records: features register a DocumentSource and call DocumentsService.request().
    DocumentsRegistry,
    DocumentTemplates,
    PdfRenderer,
    DocumentsService,
    DocumentsProcessor,
  ],
  exports: [DocumentsRegistry, PdfRenderer, DocumentsService],
})
export class DocumentsModule {}
