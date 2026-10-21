# Attachments: files on records

Files people attach to a feature's records: a contract on an order, photos
on a ticket. `apps/api/src/platform/attachments/`; notes take attachments as the
example (`features/notes/note-attachments.ts`, `attachmentRoutes()` in `notes.module.ts`).

| Route | Does |
| --- | --- |
| `POST /v1/notes/{id}/attachments` (multipart, field `file`) | 201, the attachment; who may change the note (`Note.update`) |
| `GET /v1/notes/{id}/attachments` | a page of them, newest first (`?contentType=`, `?name.contains=`, `size`, `createdAt`); who may read the note |
| `GET /v1/attachments/{id}/download` | 302 to a signed link to the file (5 minutes, no credentials needed: a link or an image works); `?inline=true` shows a PDF in the browser |
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
  record is checked: a refused request stores nothing. Keys are under the
  uploader's tenant, `tenants/<id>/attachments/…` ([tenancy](tenancy.md)):
  a tenant's files are one prefix, and an attachment row only takes a file
  of its own tenant. The nightly sweep walks the tenants one at a time. The row and its
  audit entry (`attachment.added`, `attachment.removed`) commit together;
  a failed write deletes the file.
- **Types** come from the bytes, never from the client: images and PDF by
  their signature, docx/xlsx/pptx and zip by their zip entries, UTF-8 text
  as text (served as `text/plain`, HTML included). Not allowed
  (`ATTACHMENT_ALLOWED_TYPES`), or not the type the client declared (a
  "PNG" that is text): 415 `unsupported_media_type`. Over
  `ATTACHMENT_MAX_MB` (25): 413 `payload_too_large`. Both are published
  in `GET /v1/lists/{subject}` (`attachmentLimits: { maxBytes, maxMb,
  types }`, read as the upload reads them: `attachmentLimits()`), so a
  client checks a file before sending it.
- **Malware scanning** (`MALWARE_SCANNER`, `platform/attachments/malware-scanner.ts`):
  `off` (the default) changes nothing: no scan, no pending state, an upload
  is downloadable at once, as before. `clamav` scans every upload on the
  queue (`attachment-scan`, workers), `memory` is the test double (flags the
  EICAR test string). The state is one column, `scanStatus`
  (`pending` | `clean`, shown on the attachment and filterable with
  `?scanStatus=`); there is no `rejected` state, because an infected file
  is deleted:
  - **Upload:** the row is stored `pending` (`clean` with the scanner off)
    and a scan job is queued after the commit. Files the app writes itself
    (issued PDFs, `attachStored()`) are `clean`: they are not user bytes.
  - **Pending:** `GET /v1/attachments/{id}/download` answers 409
    `attachment_scan_pending`; the row can be listed and removed. Anything
    that serves attachment bytes (a rendition, a preview, a mail
    attachment) must check `scanStatus === 'clean'` first, as `download()`
    does.
  - **Clean:** the job sets `clean` and sends `record.attachments.changed`
    with `action: 'scanned'`.
  - **Infected:** the job deletes the file and the row, audits
    `attachment.rejected` (details: the signature, name, uploader) as
    `system:attachment-scan`, sends `action: 'removed'`, and notifies the
    uploader (`attachment.rejected`: in-app, realtime, mail, webhook).
  - **Scanner failing:** clamd away, a timeout or an error answer
    (`INSTREAM size limit exceeded`) is never "clean": the job is tried again
    (`MALWARE_SCAN_ATTEMPTS`, exponential backoff from 5 s) and the file stays
    `pending`. The nightly sweep queues scans of files still pending after an
    hour (a lost job, or every attempt failed).
  - **Metric:** `attachments_scanned_total{result="clean|infected|error"}`
    (a counter per worker process: `rate()` and sum it).
  - **ClamAV:** `compose.clamav.yaml` adds the `clamav` service (the
    official image, signatures kept current by freshclam, a network of its
    own that only the workers join) and sets `MALWARE_SCANNER=clamav` and
    `CLAMAV_HOST=clamav`: [deployment](deployment.md), "ClamAV". The worker
    speaks clamd's `INSTREAM` over TCP (`clamav-scanner.ts`), streaming the
    file from the disk, never loading it. It is custom code because the npm
    clients are unmaintained (`clamdjs` last released 2022, `clamscan` 2024
    and built around callbacks and local binaries) and the protocol is a
    handful of lines. A deployment that scans elsewhere (an API, another
    engine) provides its own `MalwareScanner` (`scan(stream)` returns
    `{ infected, signature? }` or throws).
- **Realtime**: an upload, a removal or an issued PDF sends
  `record.attachments.changed` (`{ subject, recordId, attachmentId,
  action }`, `action` `added`, `removed` or `scanned`) to the record's watchers and the uploader's other tabs who
  may read it ([webhooks-and-realtime.md](webhooks-and-realtime.md),
  "Record events"); a feature that calls `attachStored()` in its own
  transaction calls `attachments.changed()` after the commit.
- **Downloads** are the disk's signed links: served at `/files` on a local
  disk, by the bucket on S3, with `Content-Disposition: attachment` and
  the file's name, `nosniff`.
- **Preview** (`?inline=true`): a PDF comes as `Content-Disposition:
  inline`, so a browser shows it (a preview in a new tab). Only
  `application/pdf` (`INLINE_TYPES`), the type read from its bytes at
  upload: any other type stays `attachment` whatever is asked, HTML, SVG
  and anything else that can script above all (and the storage package
  forces those to `attachment` again when it serves them). The disposition
  is part of what the link signs (the local disk's claims; S3's
  `response-content-disposition`, inside the SigV4 signature): turning a
  download link into a preview is a 403. Every file `/files` serves
  carries `Content-Security-Policy: default-src 'none'; frame-ancestors
  'none'; sandbox` (`FILE_CSP`, in place of the API's own policy) and
  `X-Content-Type-Options: nosniff`: nothing loads, nothing runs, no page
  frames it, and it is its own opaque origin. Chrome's PDF viewer renders
  under it (checked with Chrome 155: the viewer loads the document and its
  pages); `sandbox` is kept since nothing a PDF needs is lost. A web app
  opens the preview in a new tab (`frame-ancestors 'none'` refuses an
  `<iframe>`). **On S3** the bucket answers the link: S3 has no parameter
  for a CSP or `nosniff`, so the inline PDF comes with the `Content-Type`
  stored at upload (`application/pdf`) and the disposition only; add the
  two headers at the CDN in front of the bucket (a CloudFront response
  headers policy) if you serve previews from S3.
- **Deleted records:** a record in the recycle bin keeps its files, hidden
  with it (404) until restored. Once it is gone for good (purged by
  SoftDeletePurgeJob, or deleted outright), the nightly sweep
  (`AttachmentSweepJob`, 04:05 in `APP_TIMEZONE`, on one instance) deletes
  its attachments, file and row, and logs how many; each round's rows go
  with an `attachments.swept` audit entry (the ids) by the system principal
  `system:attachment-sweep`. A subject no target registers any more is
  left alone.
- **Issued documents** (a generated PDF, [documents.md](documents.md)) are
  attachments too, added by the app with `locked: true`: they never change,
  and `DELETE` answers 409 `attachment_locked`; they go only with their
  record (the sweep). They also carry the record's `fields` they show:
  downloading one takes the right to read every one of them (the target's
  `canReadFields`), else 404. `AttachmentsService.attachStored()` adds a
  file the app wrote itself, in the caller's transaction.
- **Personal data:** a user's uploads are in their data export
  (`kind: attachments`: the rows, not the files). When their account is
  deleted the files stay with their records; `uploadedBy` becomes
  `anonymized`. File names are kept: they belong to the record.
