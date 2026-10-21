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
- **Realtime**: an upload, a removal or an issued PDF sends
  `record.attachments.changed` (`{ subject, recordId, attachmentId,
  action }`) to the record's watchers and the uploader's other tabs who
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

## Avatars: a user's picture

The same storage layer (`StorageDisk`, `uploadToDisk()`, the bytes-first type
check `assertDeclaredType`), on a path of its own so changes to attachments
(malware scanning, thumbnails) do not reach it:
`apps/api/src/platform/account/avatar*.ts`.

| Route                                              | Does                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `PUT /v1/account/avatar` (multipart, field `file`) | 200 `{ avatarUrl }`; replaces the picture; users only, never while impersonating     |
| `DELETE /v1/account/avatar`                        | 204; the file goes too; nothing to do without one                                    |
| `GET /v1/people/{id}/avatar`                       | 200 the picture (inline, `private` cache); a member of your tenant, or you; else 404 |

- **Stored** at `accounts/<user id>/avatar/<random>.<ext>` (the picture is the
  person's, not a tenant's: one account, many tenants), its key in
  `users.avatar_key`. The key change and its audit entry
  (`account.avatar-changed`, `account.avatar-removed`) commit together; the
  file it replaces goes after the commit.
- **Types** come from the bytes: PNG, JPEG, WebP and GIF, nothing else (not
  SVG, which scripts); not the type the client declared: 415. Over
  `AVATAR_MAX_MB` (2): 413.
- **`avatarUrl`** is a stable path (`/v1/people/<id>/avatar?v=<file id>`), not a
  signed link: it is on `GET /v1/auth/me` (`user.avatarUrl`) and on every
  person `GET /v1/people` gives (a mention's, a member list's, the names
  behind the keys comments and revisions hold); null for no picture and for
  API clients. A new picture is a new `v`, so a browser's cached one is not
  shown again. The web app puts it in an `<img>` (the session cookie
  authenticates it); a client with a token fetches it with its header.
- **Served by the API, not redirected** to the disk's signed link (as an
  attachment's download is): an `<img>` follows a redirect only to an origin
  the page may load from. `pnpm dev` proxies `/v1` but not `/files`, the
  browser refuses a cross-origin image under the API's
  `Cross-Origin-Resource-Policy: same-origin`, and with `STORAGE_DRIVER=s3`
  the signed link is the bucket's host, which Caddy's `img-src 'self' data:`
  blocks. So the route streams the bytes (`serveFile()`, `inline`,
  `Cache-Control: private, max-age=300`) from the origin the page is on.
- **Personal data:** the account export's `profile` row holds `avatarKey` (the
  file's name, not the bytes). When the account is deleted the file is
  deleted and the key cleared (`AccountDeletionJob`, after the anonymization
  commits). Every file under `accounts/<id>/avatar/` goes, not only the
  current key's: a replaced picture whose delete failed (`dispose()` only
  logs it) is an orphan nothing points at, and would otherwise outlive the
  person.
- **Not done (yet):** the picture is stored as uploaded. The template has no
  image library, so it is neither resized (a 2 MB cap and the browser's
  `object-cover` stand in) nor stripped of its metadata (EXIF, GPS). When
  thumbnails and EXIF stripping arrive for attachments (#410), run the
  avatar through the same worker step: resize to a square on the queue, then
  swap `users.avatar_key`.
