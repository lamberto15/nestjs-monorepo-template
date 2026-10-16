# Attachments: files on records

Files people attach to a feature's records: a contract on an order, photos
on a ticket. `apps/api/src/platform/attachments/`; notes take attachments as the
example (`features/notes/note-attachments.ts`, `note-attachments.controller.ts`).

| Route | Does |
| --- | --- |
| `POST /v1/notes/{id}/attachments` (multipart, field `file`) | 201, the attachment; who may change the note (`Note.update`) |
| `GET /v1/notes/{id}/attachments` | a page of them, newest first (`?contentType=`, `?name.contains=`, `size`, `createdAt`); who may read the note |
| `GET /v1/attachments/{id}/download` | 302 to a signed link to the file (5 minutes, no credentials needed: a link or an image works) |
| `DELETE /v1/attachments/{id}` | 204; the uploader, or who may change the record; the file goes too |

A feature registers an `AttachmentTarget` and adds the two record routes:

```ts
@Injectable()
export class NoteAttachments implements AttachmentTarget {
  readonly subject = 'Note';
  constructor(…, registry: AttachmentsRegistry) { registry.register(this); }
  canRead(principal, id)  { … }   // false for a missing or deleted record: 404
  canWrite(principal, id) { … }   // upload, and removing others' files
  exists(ids)             { … }   // which still exist, recycle bin included
}

@Post(':id/attachments')
@UseInterceptors(AttachmentUpload('Note'))   // checks canWrite, then streams the file to the disk
upload(…, @UploadedFile() file: StoredUpload) { return this.attachments.upload(user, { subject: 'Note', recordId: id }, file, ip); }
```

- **Uploads** stream onto the private disk (`StorageDisk`, as imports do:
  `uploadToDisk()`), never into memory, after the caller's right to the
  record is checked: a refused request stores nothing. The row and its
  audit entry (`attachment.added`, `attachment.removed`) commit together;
  a failed write deletes the file.
- **Types** come from the bytes, never from the client: images and PDF by
  their signature, docx/xlsx/pptx and zip by their zip entries, UTF-8 text
  as text (served as `text/plain`, HTML included). Not allowed
  (`ATTACHMENT_ALLOWED_TYPES`), or not the type the client declared (a
  "PNG" that is text): 415 `unsupported_media_type`. Over
  `ATTACHMENT_MAX_MB` (25): 413 `payload_too_large`.
- **Downloads** are the disk's signed links: served at `/files` on a local
  disk, by the bucket on S3, with `Content-Disposition: attachment` and
  the file's name, `nosniff`.
- **Deleted records:** a record in the recycle bin keeps its files, hidden
  with it (404) until restored. Once it is gone for good (purged by
  SoftDeletePurgeJob, or deleted outright), the nightly sweep
  (`AttachmentSweepJob`, 04:05 in `APP_TIMEZONE`, on one instance) deletes
  its attachments, file and row, and logs how many; each round's rows go
  with an `attachments.swept` audit entry (the ids) by the system principal
  `system:attachment-sweep`. A subject no target registers any more is
  left alone.
- **Personal data:** a user's uploads are in their data export
  (`kind: attachments`: the rows, not the files). When their account is
  deleted the files stay with their records; `uploadedBy` becomes
  `anonymized`. File names are kept: they belong to the record.
