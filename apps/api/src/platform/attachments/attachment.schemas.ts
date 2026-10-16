import { z } from 'zod';

/** A file attached to a record. */
export const attachmentSchema = z.object({
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
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AttachmentView = z.infer<typeof attachmentSchema>;

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
