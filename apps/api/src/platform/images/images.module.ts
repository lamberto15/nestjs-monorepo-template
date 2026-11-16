import { Module } from '@nestjs/common';
import { ImageProcessor } from './image-processor.js';
import { ConfigService } from '@nestjs/config';
import { imageProcessor } from './image-processor.factory.js';

/**
 * The images capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule
 * (platform.module.ts).
 */
@Module({
  providers: [
    // Thumbnails, previews and stripped metadata of uploaded images (IMAGE_PROCESSING, on by default): a queue job per image, once it is clean.
    {
      provide: ImageProcessor,
      inject: [ConfigService],
      useFactory: imageProcessor,
    },
  ],
  exports: [ImageProcessor],
})
export class ImagesModule {}
