# Attachments: files on records

Files people attach to a feature's records: a contract on an order, photos
on a ticket. `apps/api/src/platform/attachments/`; notes take attachments as the
example (`features/notes/note-attachments.ts`, `attachmentRoutes()` in `notes.module.ts`).

| Route | Does |
| --- | --- |
| `POST /v1/notes/{id}/attachments` (multipart, field `file`) | 201, the attachment; who may change the note (`Note.update`) |
| `POST /v1/notes/{id}/attachments/presign` (JSON `{ name, size, contentType }`) | 201, a signed PUT URL to the object store, `STORAGE_DRIVER=s3` only, else 503 `presigned_uploads_unavailable`; the same right as the upload ([Direct uploads](#direct-uploads-s3)) |
| `POST /v1/notes/{id}/attachments/complete` (JSON `{ uploadId }`) | 201, the attachment, once the file is in the store and was checked ([Direct uploads](#direct-uploads-s3)) |
| `GET /v1/notes/{id}/attachments` | a page of them, newest first (`?contentType=`, `?name.contains=`, `size`, `createdAt`); who may read the note |
| `GET /v1/attachments/{id}/download` | 302 to a signed link to the file (5 minutes, no credentials needed: a link or an image works); `?inline=true` shows a PDF in the browser; `?rendition=thumb\|preview` links to an image's smaller copy ([Image renditions](#image-renditions)) |
| `DELETE /v1/attachments/{id}` | 204; the uploader, or who may change the record; the file goes too |

A feature registers an `AttachmentTarget` and adds the two record routes:

```ts
@Injectable()
export class NoteAttachments implements AttachmentTarget {
  readonly subject = 'Note';
  constructor(…, registry: AttachmentsRegistry) { registry.register(this); }
  canRead(principal, id)  { … }   // false for a missing or deleted record: 404
  canWrite(principal, id) { … }   // upload, and removing others' files
  readonly records = { table: notes, id: notes.id };   // the sweep's join: no row there, the record is gone
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
    (`MALWARE_SCAN_ATTEMPTS`, exponential backoff from 5 s: about 75 s with
    the default 5) and the file stays `pending`. Past that, and when the
    scan could not even be queued, `AttachmentScanRetryJob` (every five
    minutes, one instance, each tenant in turn) queues the scans of files
    still pending after five minutes again: a clamd restart costs minutes
    of `pending`, not a night.
  - **Scanning switched off:** `MALWARE_SCANNER=off` while uploads are
    `pending`: nothing will ever scan them, so the same job releases them as
    `clean` (unscanned, like the files stored before scanning was switched
    on) with an `attachments.released` audit entry (the ids) by
    `system:attachment-scan`, and a queued scan job ends as `skipped`.
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
  action }`, `action` `added`, `removed`, `scanned` or `processed`) to the record's watchers and the uploader's other tabs who
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
  its attachments (found in the database: no row of the record is left), file and row, and logs how many; each round's rows go
  with an `attachments.swept` audit entry (the ids) by the system principal
  `system:attachment-sweep`. A subject no target registers any more is
  left alone. The same sweep removes the direct uploads nobody completed
  ([Direct uploads](#direct-uploads-s3)); that round is audited as
  `attachments.uploads-swept` (the upload ids).
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
  `anonymized`. File names are kept: they belong to the record. A direct
  upload announced and not completed ([Direct uploads](#direct-uploads-s3))
  is not in the export; on deletion its `uploadedBy` becomes `anonymized`
  too, and the sweep removes it with its object.

## Direct uploads (S3)

With `STORAGE_DRIVER=s3` a client can send a file straight to the bucket
instead of through the API, which spares the API the bytes (its memory, its
request time and its bandwidth; the multipart upload still works and is the
only way with the local driver). `GET /v1/features` says so
(`presignedUploads`, [configuration](configuration.md#which-switches-are-on-get-v1features)); the routes are
`attachmentRoutes()`'s, beside the multipart upload
(`attachment-uploads.service.ts`):

1. **`POST /v1/notes/{id}/attachments/presign`**, `{ name, size,
   contentType }`: needs the right to attach files to the record (the
   upload's: 404 for a record the caller cannot read, 403 for a reader) and
   refuses what the upload refuses before any byte moves: over
   `ATTACHMENT_MAX_MB` 413, a type not allowed (`ATTACHMENT_ALLOWED_TYPES`)
   or not declared 415 (`contentType` is required: the URL is signed for it;
   text is signed as the upload through the API types it,
   `text/plain; charset=utf-8` or `text/csv; charset=utf-8`), the tenant's
   storage quota 422 `quota_exceeded`. It answers 201 `{ uploadId, url,
   method: 'PUT', headers, expiresAt }`.
2. **The client PUTs the file to `url`** with `headers` as they are
   (`content-type`, and `x-amz-server-side-encryption` when the deployment
   encrypts at rest; the browser sets `Content-Length` itself). The URL
   (SigV4, `@nestjs/storage`'s `signedUpload()`) is bound to the key, the size
   and the `Content-Type`, and works for ten minutes (`UPLOAD_LINK_TTL`): a
   body of another size or type, or a late one, is refused by the bucket
   (403). The key is the server's, under the tenant's prefix
   (`tenants/<id>/attachments/…`, the one an upload through the API gets),
   never the client's.
3. **`POST /v1/notes/{id}/attachments/complete`**, `{ uploadId }`: the
   announcer's own upload for this record (404 `attachment_upload_not_found`
   otherwise). It checks the right again, then **copies the object to a key
   of the server's own** (`tenants/<id>/attachments/…`, which no signed URL
   reaches) and reads the copy back: its size and `Content-Type` (HEAD) and
   its first 64 KiB (a ranged GET), and types it from those bytes exactly as
   the upload does (signatures, zip entries, text), so the type must be
   allowed and must not contradict the declared one. The copy matters: the
   signed URL works until it expires, and whoever holds it can PUT again, so
   a file checked and scanned where it was PUT could be replaced after
   both. What was PUT is never the attachment's file; it is deleted on
   completion. A file that is not what was announced is deleted and
   refused: 413, 415, or 400 `attachment_upload_mismatch`. When nothing was
   PUT yet it is 409 `attachment_upload_incomplete` and the upload stays: PUT,
   then complete again. Then `AttachmentsService.upload()` creates the
   attachment from the copy, **the same path as an upload through the API**: the quota,
   the tenant, the audit entry (`attachment.added`), the malware scan
   (`pending` until it is done) and the image renditions. Completing twice
   makes one attachment (409 `attachment_upload_in_progress` while another
   request completes it, 404 after).

- **State** is a row per announced upload (`attachment_uploads`: key, name,
  size, type, uploader, expiry), marked completed (`completedAt`) in the
  transaction that creates the attachment and deleted by the sweep once the
  URL has expired, so that whatever is PUT to the URL after the completion is
  deleted with it. An uploader may have 100 announced, not completed and not
  expired (`MAX_PENDING_UPLOADS`, 429 `attachment_uploads_pending`): a link
  that expired, say after a PUT that failed, frees its place at once, though
  the sweep deletes the row only at night. The storage quota counts
  attachments, not what was PUT and never completed.
- **A late PUT** may still be arriving when the URL expires: an upload may be
  completed for an hour after (`UPLOAD_GRACE_MS`); past that it is 410
  `attachment_upload_expired` and the object is deleted.
- **Never completed** (the client went away): the nightly sweep
  ([above](#attachments-files-on-records), "Deleted records") deletes the
  object and the row of every upload an hour past its expiry, and never a
  file an attachment uses. It audits `attachments.uploads-swept`. The rows of
  completed uploads go with it (with an object PUT again, if any), unaudited.
- **The bucket needs a CORS rule** for the web app's origin, since the
  browser sends the PUT: `AllowedMethods: PUT`, `AllowedOrigins` the web app's
  origin(s), `AllowedHeaders: *` (or `content-type` and
  `x-amz-server-side-encryption`). Without one the browser cannot reach the
  bucket: the web app notices (no answer from the store) and uploads that
  file through the API instead, so uploads keep working, only not directly.
- **The web app's Content-Security-Policy must name the bucket** too: the
  browser blocks a request to another origin that `connect-src` does not list,
  before any CORS preflight. The Compose stack's Caddy and the Helm chart's
  web app derive the bucket's origin from the S3 settings and name it in
  `connect-src` and `img-src` themselves when `STORAGE_DRIVER=s3` (one list,
  which also lets the [thumbnails](#image-renditions) load; `FILES_ORIGIN`
  adds a custom domain or CDN in front of the bucket: [deployment.md](deployment.md),
  "The origins of files"); a deployment that serves the web app another way
  adds it to its own policy.
- **The web app's dropzone** uses it whenever `presignedUploads` is on and the
  browser names the file's type (a signed URL is bound to one; a file with no
  type goes through the API, which decides). It falls back to the multipart
  upload when the store cannot be reached or the server answers 503
  `presigned_uploads_unavailable` or 429 `attachment_uploads_pending` (the
  multipart upload leaves no announcement behind); a refusal by the API (415, 413, 422) is
  shown as it is, and the store's (an expired link) as "the upload link was
  refused or has expired".
- **Tested** with an in-memory disk that does what S3 does with a presigned
  PUT (`test/attachments-presign.e2e-spec.ts`: signature, expiry, size and
  type checked at the PUT) and with the S3 disk's own signing and its
  HEAD and ranged GET against a stubbed `fetch`
  (`attachment-types.spec.ts`, `attachment-upload-check.spec.ts`). Nothing
  here has run against a real bucket or MinIO.

## Image renditions

A JPEG, PNG, WebP or GIF upload (by its bytes; SVG, AVIF and HEIC are stored
as uploaded) gets a `thumb` and a `preview`, and its metadata (EXIF, GPS) is
stripped, by a queue job on a worker (`attachment-images`,
[background-work.md](background-work.md)) once the malware scan found it
clean. `IMAGE_PROCESSING` (on by default). The code is `platform/images/` (the
processor, which knows nothing of attachments) and `attachment-images.*` in
`platform/attachments/` (the job). [sharp](https://sharp.pixelplumbing.com/)
does the work: pinned, its libvips a prebuilt binary (the image installs
nothing for it), loaded by a worker on its first image, never by the API.

- **State:** `renditionStatus` on the attachment: `pending` from the upload
  (null for anything that is not processed, and for everything stored while
  `IMAGE_PROCESSING=off`), then `ready` or `failed`. `renditions` holds
  `thumb` and `preview` once ready, each `{ width, height, size,
  contentType }`, never a storage key. The original can be downloaded while
  `pending`.
- **When:** after the malware scan found the file clean: with the scanner
  off the upload queues the job; with it on, the scan does when it sets
  `clean` (so a rendition is never made of a file nobody may serve, and an
  infected image is deleted without being decoded). A job lost with Redis,
  or retries spent while the disk was away, are picked up by
  `AttachmentImagesRetryJob` (every five minutes, one instance, each tenant
  in turn) for images still pending five minutes after they became
  processable.
- **Renditions:** WebP (every current browser shows it, with
  transparency), upright (the EXIF orientation applied to the pixels),
  without metadata, never enlarged: `thumb` fits in 256 × 256 pixels
  (quality 75), `preview` in 1600 × 1600 (quality 80), the proportions
  kept. An animated GIF, WebP or PNG gives its first frame. They are stored
  under the tenant's prefix like the original, at keys unique to the
  processing run (`attachments/<uuid>.thumb.webp`, `<uuid>.preview.webp`;
  a stripped original of the same run is `<uuid>.jpg`): two jobs on one
  image (the retry job's duplicate, a stalled job run again) never write the
  same file, so the one that loses deletes only its own. They go with the
  attachment: removing it, the nightly sweep and deleting the tenant take
  them too.
- **Download:** `GET /v1/attachments/{id}/download?rendition=thumb` (or
  `preview`) answers like the download of the file: 302 to a signed link
  (5 minutes), as `inline` and named `photo.thumb.webp`. 404
  `attachment_rendition_not_found` when there is none: not an image, still
  `pending` (the message says so; try again, or wait for the realtime
  `processed`), or `failed`. The scan check comes first (409
  `attachment_scan_pending`). Like every download, an `<img>` follows the
  redirect only to an origin the page may load from: the avatar section
  below says what that costs. The web app's attachments panel does this
  (`components/records/panels/attachment-visual.tsx`), so both ends are set up
  for it: `pnpm dev` rewrites the redirect's host to the page's and proxies
  `/files` (`apps/web/dev-proxy.ts`, [monorepo](monorepo.md), "The web
  app"); under Caddy the local disk's link is the app's own origin, and with
  S3 the bucket's origin is in `img-src`, derived from the S3 settings like
  the direct uploads' `connect-src` ([deployment](deployment.md), "The origins
  of files").
- **In the web app:** an image `ready` shows its `thumb` in the attachments panel,
  sized from `renditions.thumb.width` and `height`, and opens its `preview` in a
  dialog with the original downloadable; a placeholder while `pending`; the file icon
  for `failed`, for everything not processed, and for a thumbnail that does not load
  (a CSP that refuses the redirect's origin, say). The list is read again on
  `processed`, and every 10 s (5 s without a socket) while an image is `pending`,
  because the worker's events reach only the record's watchers, not an uploader who
  does not watch it.
- **Metadata of the original:** an original that carries EXIF, XMP, IPTC,
  Photoshop resources or PNG text is replaced by a copy without it,
  rotated upright, in the same format (JPEG and lossy WebP re-encoded at
  quality 90, so a little larger or smaller; PNG and lossless WebP without
  loss, a palette staying one), colours in sRGB (the ICC profile goes too).
  A PNG's EXIF and text chunks count wherever they are, after the image
  data too (the library reads only the ones before it). A copy more than
  four times the original's size (plus 64 KB: a PNG can be built to
  compress only as uploaded), larger than `ATTACHMENT_MAX_MB`, or larger
  than the original by more than the tenant's storage quota has room for
  is not stored: the image ends `failed` (`size`, `quota`). The copy is written
  under a new key and the row changed in one transaction with the audit
  entry; the old file is deleted after the commit, so a download in
  between gets one whole file or the other and a failure leaves the
  original where it was. `size` becomes the copy's. An original **without**
  metadata stays byte for byte as uploaded, as do a GIF (it has no EXIF),
  an animated WebP or PNG (a copy would be a still; the library loads only
  an APNG's first image, so the `acTL` chunk is how it is told) and an
  image of more than 8 bits per channel.
  `IMAGE_STRIP_ORIGINALS=off` keeps every original as uploaded (evidence,
  a legal copy); the renditions are stripped whatever it says. A JPEG whose
  only metadata is a COM comment is not touched: the library does not
  report it.
- **Limits, and failure:** the pixel count of one frame is read from the
  header before anything is decoded and must not pass `IMAGE_MAX_PIXELS`
  (50 million: a 50 KB PNG can claim gigapixels, the usual decompression
  bomb); one conversion may take `IMAGE_TIMEOUT_MS` (30 s); a file over
  64 MiB is not loaded whatever `ATTACHMENT_MAX_MB` says. The library's
  strictest `failOn` (the default) refuses a damaged or truncated file
  instead of repairing it. An image that is refused, or is not what its
  bytes said, ends `failed`: **the original is as uploaded, its metadata
  included**, a warning is logged with the reason (`pixels`, `size`,
  `format`, `timeout`, `invalid`, `missing`, `quota`, `stalled`), and
  nothing tries again (the same bytes fail the same way). A disk or
  database failure is not that: the job is tried again (the queue's three
  attempts, with backoff), then the retry job. A worker that dies while
  converting (killed at its memory limit, a crash in the library) gets the
  job back once (BullMQ's stalled-job check); when it dies on it again the
  image ends `failed` (`stalled`), so one upload can't take the worker down
  every five minutes. One image at a time per worker process, and the
  memory it takes lives outside the V8 heap (measured: the whole process
  stays near 140 MB resident while it converts a 48-megapixel JPEG that
  needs rotating, with no temporary file): see "Resource limits" in
  [deployment.md](deployment.md).
- **Audit:** `attachment.processed` by `system:attachment-images`
  (renditions made, the kinds of metadata removed, the size before and
  after when the original was replaced); realtime
  `record.attachments.changed` with `action: 'processed'` after a success
  and after a failure, so a panel stops waiting. Metric
  `attachment_images_processed_total{result="ready|failed|error"}` (a
  counter per worker process: `rate()` and sum it; `error` is a disk or
  database failure that is tried again).
- **Switching it off:** `IMAGE_PROCESSING=off` stores images as uploaded
  with no state; images still `pending` lose it within minutes (the same
  retry job), their files untouched. Switching it **on** does not reach back:
  attachments stored before are not processed (no backfill), so their
  originals keep their EXIF.
- **Not counted:** the storage quota (`storageBytes`) counts the original's
  size (a stripped copy's once it replaces it), not the renditions
  (derived, a few hundred KB at most each).
- **Another format:** add its type to `IMAGE_INPUT_TYPES`
  (`platform/images/renditions.ts`) once the library reads it and the
  storage package recognizes it from its bytes.

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
  the page may load from. The browser refuses a cross-origin image under the
  API's `Cross-Origin-Resource-Policy: same-origin` (`pnpm dev` proxies `/files`
  and rewrites the redirect to the page's origin now, for the attachments'
  thumbnails: [Image renditions](#image-renditions)), and with
  `STORAGE_DRIVER=s3` the signed link is the bucket's host, which the page's
  `img-src` must name (Caddy's does: [deployment](deployment.md), "The origins
  of files"; a policy of your own may not). The avatar needs neither: the
  route streams the bytes (`serveFile()`, `inline`,
  `Cache-Control: private, max-age=300`) from the origin the page is on.
- **Personal data:** the account export's `profile` row holds `avatarKey` (the
  file's name, not the bytes). When the account is deleted the file is
  deleted and the key cleared (`AccountDeletionJob`, after the anonymization
  commits). Every file under `accounts/<id>/avatar/` goes, not only the
  current key's: a replaced picture whose delete failed (`dispose()` only
  logs it) is an orphan nothing points at, and would otherwise outlive the
  person.
- **Not done (yet):** the picture is stored as uploaded: neither resized (a
  2 MB cap and the browser's `object-cover` stand in) nor stripped of its
  metadata (EXIF, GPS). The image library is in the template now
  (`ImageProcessor`, [Image renditions](#image-renditions), which knows
  nothing of attachments), so the avatar can go through the same step: resize
  to a square on the queue, then swap `users.avatar_key`.
