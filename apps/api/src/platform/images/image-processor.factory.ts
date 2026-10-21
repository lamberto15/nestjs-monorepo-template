import type { ConfigService } from '@nestjs/config';
import type { PlatformEnv } from '../platform.env.js';
import { ImageProcessor } from './image-processor.js';

/** The processor IMAGE_MAX_PIXELS, IMAGE_TIMEOUT_MS and IMAGE_STRIP_ORIGINALS describe (the provider's factory). */
export function imageProcessor(
  config: ConfigService<PlatformEnv, true>,
): ImageProcessor {
  return new ImageProcessor({
    maxPixels: config.get('IMAGE_MAX_PIXELS', { infer: true }),
    timeoutMs: config.get('IMAGE_TIMEOUT_MS', { infer: true }),
    stripOriginals: config.get('IMAGE_STRIP_ORIGINALS', { infer: true }),
  });
}
