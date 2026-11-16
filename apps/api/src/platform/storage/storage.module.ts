import { Module } from '@nestjs/common';
import { FilesController } from './files.controller.js';

/**
 * The storage capability's routes: the signed links to stored files. The disk
 * itself is @nestjs/storage's StorageModule (storage.config.ts), which
 * PlatformModule imports. Imported by PlatformModule (platform.module.ts).
 */
@Module({
  controllers: [FilesController],
})
export class PlatformStorageModule {}
