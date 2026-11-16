import { Module } from '@nestjs/common';
import { AttachmentsRegistry } from './attachments.registry.js';
import { MalwareScanner } from './malware-scanner.js';
import { ConfigService } from '@nestjs/config';
import { malwareScanner } from './malware-scanner.factory.js';
import { AttachmentScanQueue } from './attachment-scan.queue.js';
import { AttachmentScanService } from './attachment-scan.service.js';
import { AttachmentScanProcessor } from './attachment-scan.processor.js';
import { AttachmentScanRetryJob } from './attachment-scan-retry.job.js';
import { AttachmentImagesQueue } from './attachment-images.queue.js';
import { AttachmentImagesService } from './attachment-images.service.js';
import { AttachmentImagesProcessor } from './attachment-images.processor.js';
import { AttachmentImagesRetryJob } from './attachment-images-retry.job.js';
import { TextExtractor } from './text-extractor.js';
import { type PlatformEnv } from '../platform.env.js';
import { AttachmentTextQueue } from './attachment-text.queue.js';
import { AttachmentTextService } from './attachment-text.service.js';
import { AttachmentTextProcessor } from './attachment-text.processor.js';
import { AttachmentTextRetryJob } from './attachment-text-retry.job.js';
import { AttachmentSearch } from './attachment.search.js';
import { AttachmentsService } from './attachments.service.js';
import { AttachmentUploadsService } from './attachment-uploads.service.js';
import { AttachmentVersionsService } from './attachment-versions.service.js';
import { AttachmentSweepJob } from './attachment-sweep.job.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { AccountModule } from '../account/account.module.js';
import { SearchModule } from '../search/search.module.js';
import { ImagesModule } from '../images/images.module.js';
import { AttachmentsController } from './attachments.controller.js';

/**
 * The attachments capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [PlatformKernelModule, AccountModule, SearchModule, ImagesModule],
  controllers: [AttachmentsController],
  providers: [
    // Files attached to records: features register an AttachmentTarget.
    AttachmentsRegistry,
    // Malware scanning of uploads (MALWARE_SCANNER, off by default): a queue job per upload.
    {
      provide: MalwareScanner,
      inject: [ConfigService],
      useFactory: malwareScanner,
    },
    AttachmentScanQueue,
    AttachmentScanService,
    AttachmentScanProcessor,
    AttachmentScanRetryJob,
    AttachmentImagesQueue,
    AttachmentImagesService,
    AttachmentImagesProcessor,
    AttachmentImagesRetryJob,
    // Search inside files (ATTACHMENT_TEXT_SEARCH, off by default): a queue job extracts a clean upload's text in a sandboxed thread.
    {
      provide: TextExtractor,
      inject: [ConfigService],
      useFactory: (config: ConfigService<PlatformEnv, true>) =>
        new TextExtractor({
          maxBytes:
            config.get('ATTACHMENT_TEXT_MAX_MB', { infer: true }) * 1024 * 1024,
          timeoutMs: config.get('ATTACHMENT_TEXT_TIMEOUT_MS', {
            infer: true,
          }),
        }),
    },
    AttachmentTextQueue,
    AttachmentTextService,
    AttachmentTextProcessor,
    AttachmentTextRetryJob,
    AttachmentSearch,
    AttachmentsService,
    // Uploads straight to the object store (STORAGE_DRIVER=s3): presign, then complete through AttachmentsService.upload().
    AttachmentUploadsService,
    AttachmentVersionsService,
    AttachmentSweepJob,
  ],
  exports: [
    AttachmentsRegistry,
    AttachmentsService,
    AttachmentUploadsService,
    AttachmentVersionsService,
  ],
})
export class AttachmentsModule {}
