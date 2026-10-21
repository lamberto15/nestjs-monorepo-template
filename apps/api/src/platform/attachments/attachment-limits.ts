import type { ConfigService } from '@nestjs/config';
import type { PlatformEnv } from '../platform.env.js';

/** What an attachment may be: its largest size and its types (ATTACHMENT_MAX_MB, ATTACHMENT_ALLOWED_TYPES). */
export interface AttachmentLimits {
  /** The largest file, in bytes (ATTACHMENT_MAX_MB × 1024²): a larger one is a 413. */
  maxBytes: number;
  /** The same, in MB, as ATTACHMENT_MAX_MB says it. */
  maxMb: number;
  /** The types a file may be, recognized from its bytes: another is a 415. */
  types: string[];
}

/**
 * The limits the upload route enforces (AttachmentUpload), read once from
 * the configuration for both it and GET /v1/lists/{subject}
 * (`attachmentLimits`), so what a client is told is what the route refuses.
 */
export function attachmentLimits(
  config: ConfigService<PlatformEnv, true>,
): AttachmentLimits {
  const maxMb = config.get('ATTACHMENT_MAX_MB', { infer: true });
  return {
    maxBytes: maxMb * 1024 * 1024,
    maxMb,
    types: [...config.get('ATTACHMENT_ALLOWED_TYPES', { infer: true })],
  };
}

/**
 * Whether uploads may go straight to the object store with a signed URL
 * (`POST …/attachments/presign`), given `STORAGE_DRIVER`: with `s3` only. On
 * a local or in-memory disk the "store" is this API, so a signed URL would
 * still stream through it. Asked by the routes (AttachmentUploadsService)
 * and by `GET /v1/features` (`presignedUploads`) alike, so a client is never
 * told a route works that refuses.
 */
export const presignedUploads = (storageDriver: string) =>
  storageDriver === 's3';
