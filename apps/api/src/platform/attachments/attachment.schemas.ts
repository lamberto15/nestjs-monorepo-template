import { pageSchema } from '../../core/http/pagination.js';
import { z } from 'zod';

/** A derived file of an image attachment: how big it is, not where it is stored. */
export const renditionSchema = z
  .object({
    width: z.number().int().describe('Pixels, upright.'),
    height: z.number().int().describe('Pixels, upright.'),
    size: z.number().int().describe('Bytes.'),
    contentType: z.string().meta({ example: 'image/webp' }),
  })
  .meta({ id: 'AttachmentRendition' });

/** A file attached to a record. */
export const attachmentSchema = z
  .object({
    id: z.uuid(),
    subject: z.string().meta({ example: 'Note' }),
    recordId: z.uuid(),
    name: z.string().meta({ example: 'invoice.pdf' }),
    size: z.number().int().describe('Bytes.'),
    contentType: z
      .string()
      .meta({ example: 'application/pdf' })
      .describe("Detected from the file's bytes."),
    uploadedBy: z
      .string()
      .meta({ example: 'user:0199a3f2-…' })
      .describe('`user:<id>`, `client:<id>`, or `anonymized`.'),
    locked: z
      .boolean()
      .describe(
        'An issued document (a generated PDF): it never changes and cannot be removed; it goes with its record.',
      ),
    scanStatus: z
      .enum(['pending', 'clean'])
      .describe(
        '`pending`: the malware scan has not finished (MALWARE_SCANNER is on) and the file cannot be downloaded yet (409 `attachment_scan_pending`). `clean` otherwise, always when scanning is off. An infected file is rejected: the attachment is deleted and its uploader notified.',
      ),
    renditionStatus: z
      .enum(['pending', 'ready', 'failed'])
      .nullable()
      .describe(
        'Only for JPEG, PNG, WebP and GIF uploads while IMAGE_PROCESSING is on, else null. `pending`: the thumbnail and preview are being made (after the malware scan, when it is on); the original can be downloaded meanwhile. `ready`: `renditions` has them. `failed`: the image could not be processed (more than IMAGE_MAX_PIXELS, damaged, over the time limit); the file stays as it was uploaded.',
      ),
    renditions: z
      .object({
        thumb: renditionSchema.optional(),
        preview: renditionSchema.optional(),
      })
      .describe(
        'Smaller WebP copies of an image, upright and without metadata: `thumb` fits in 256 × 256 pixels, `preview` in 1600 × 1600 (neither enlarges). Empty until `renditionStatus` is `ready`. Download one with `GET /v1/attachments/{id}/download?rendition=thumb|preview`.',
      ),
    version: z
      .number()
      .int()
      .describe(
        'The number of the current file: 1, and one more with every replacement or restoration (`GET /v1/attachments/{id}/versions`).',
      ),
    revisionNote: z
      .string()
      .nullable()
      .describe('The note given with the current version, if any.'),
    versionedAt: z.iso
      .datetime()
      .describe('When the current version was put in place.'),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Attachment' });
export type AttachmentView = z.infer<typeof attachmentSchema>;

/** A page of attachments (`GET …/attachments`). */
export const attachmentPageSchema = pageSchema(attachmentSchema).meta({
  id: 'AttachmentPage',
});

/** The multipart body of an upload. */
export const attachmentUploadSchema = z.object({
  // Documents the upload: Swagger takes a @Body schema over @ApiBody, so the
  // file is declared here. Multer has taken it out of the body by the time
  // this validates, hence optional; the route answers 400 without it.
  file: z.unknown().optional().meta({
    type: 'string',
    format: 'binary',
    description:
      'Required. Its type is read from its bytes and must be allowed (ATTACHMENT_ALLOWED_TYPES: images, PDF, Office, text, zip by default), its size at most ATTACHMENT_MAX_MB (25).',
  }),
});

/** The body of `POST …/attachments/presign`: what the client is about to upload. */
export const attachmentPresignSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .meta({ example: 'invoice.pdf' })
    .describe('The file name, shown and used for downloads. Never a path.'),
  size: z
    .number()
    .int()
    .min(1)
    .describe(
      'The size in bytes. The URL accepts exactly this many; at most ATTACHMENT_MAX_MB (413 `payload_too_large`).',
    ),
  contentType: z
    .string()
    .min(1)
    .max(255)
    .meta({ example: 'application/pdf' })
    .describe(
      "The file's type, as the browser names it (`File.type`). Required, and one of the allowed types (415 `unsupported_media_type`); the URL accepts only this `Content-Type`. It is checked against the file's bytes on completion.",
    ),
});
export type AttachmentPresign = z.infer<typeof attachmentPresignSchema>;

/** A signed URL to PUT the file to, and the upload to complete afterwards. */
export const presignedUploadSchema = z
  .object({
    uploadId: z
      .uuid()
      .describe(
        'Send it to `POST …/attachments/complete` once the PUT is done.',
      ),
    url: z
      .url()
      .describe(
        'PUT the file here, with the `headers`. Signed for this size and type only, and for ten minutes.',
      ),
    method: z.literal('PUT'),
    headers: z
      .record(z.string(), z.string())
      .describe(
        'Send them as they are (`Content-Type`, and the encryption header when the bucket uses one). `Content-Length` is the file size: the HTTP client sets it.',
      ),
    expiresAt: z.iso
      .datetime()
      .describe(
        'When the URL stops working. The upload may be completed for an hour after it.',
      ),
  })
  .meta({ id: 'PresignedUpload' });
export type PresignedUploadView = z.infer<typeof presignedUploadSchema>;

/** The body of `POST …/attachments/complete`. */
export const attachmentCompleteSchema = z.object({
  uploadId: z.uuid().describe('The `uploadId` of the presign answer.'),
});

/** A resumable upload session. */
export const uploadSessionSchema = z
  .object({
    uploadId: z
      .uuid()
      .describe('Names the session in every call, and in `…/complete`.'),
    name: z.string(),
    size: z.number().int().describe('The announced size in bytes.'),
    contentType: z.string(),
    received: z
      .number()
      .int()
      .describe(
        'Bytes stored so far, which is the offset of the next chunk (progress is `received / size`).',
      ),
    chunkSize: z
      .number()
      .int()
      .describe('The most one chunk may carry, in bytes.'),
    expiresAt: z.iso
      .datetime()
      .describe(
        'When the session stops taking chunks; its chunks are removed shortly after.',
      ),
  })
  .meta({ id: 'UploadSession' });
export type UploadSessionView = z.infer<typeof uploadSessionSchema>;

/** `?offset=` of `PUT …/attachments/sessions/{uploadId}`. */
export const uploadChunkQuerySchema = z.object({
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .describe(
      "Where this chunk starts: the session's `received`. 409 `attachment_upload_offset_mismatch` otherwise.",
    ),
});

/** One version of an attachment's file. */
export const attachmentVersionSchema = z
  .object({
    version: z.number().int(),
    current: z.boolean().describe('The file the attachment serves now.'),
    name: z.string(),
    size: z.number().int().describe('Bytes.'),
    contentType: z.string(),
    uploadedBy: z
      .string()
      .describe('`user:<id>`, `client:<id>`, or `anonymized`.'),
    note: z.string().nullable().describe('The revision note it was given.'),
    uploadedAt: z.iso
      .datetime()
      .describe("When it became the attachment's file."),
  })
  .meta({ id: 'AttachmentVersion' });
export type AttachmentVersionView = z.infer<typeof attachmentVersionSchema>;

/** The versions of an attachment, newest first (`GET /v1/attachments/{id}/versions`). */
export const attachmentVersionListSchema = z
  .object({ items: z.array(attachmentVersionSchema) })
  .meta({ id: 'AttachmentVersionList' });

/** The text fields of a replacement (multipart) and of a restoration (JSON). */
export const attachmentVersionNoteSchema = z.object({
  note: z
    .string()
    .max(1000)
    .optional()
    .describe('Why the file changed, kept with the version.'),
  file: z.unknown().optional().meta({
    type: 'string',
    format: 'binary',
    description:
      'Required for a replacement: checked like any upload (type from its bytes, size, quota, malware scan).',
  }),
});

/** The body of `POST /v1/attachments/{id}/versions/{version}/restore`. */
export const attachmentRestoreSchema = attachmentVersionNoteSchema.pick({
  note: true,
});
