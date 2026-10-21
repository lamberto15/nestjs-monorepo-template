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
