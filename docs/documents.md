# PDF documents

A PDF of a record (an invoice, a certificate, a note) in the reader's
language: a template filled in on a worker, rendered by
[Gotenberg](https://gotenberg.dev) (Chromium in its own container), then
issued as an attachment of the record. `apps/api/src/platform/documents/`;
notes are the example (`features/notes/note-documents.ts`,
`note-documents.controller.ts`, the template `apps/api/src/documents/templates/note.html`).

## For clients

| Route | Does |
| --- | --- |
| `POST /v1/notes/{id}/pdf` (`Idempotency-Key` required) | 202 `{ id, status: "queued" }`; whoever may read the note; 10 a minute per user |
| `GET /v1/documents/{id}` | `{ id, source, subject, recordId, locale, status, attachmentId, error, issuedAt, … }`; whoever may read the record and every field the document shows |
| `GET /v1/attachments/{attachmentId}/download` | 302 to a signed link to the PDF (5 minutes); whoever may read the record and every field the document shows |

- **The answer is at once**, the PDF comes later: `status` goes `queued` →
  `rendering` → `completed` (then `attachmentId`) or `failed` (then
  `error`, written for people). The requester's realtime connection hears
  `document.ready { id, subject, recordId, attachmentId }` or
  `document.failed { id, subject, recordId, error }`. The same shape as the
  other jobs (bulk runs, exports): a 202 with an id, a status route, a
  realtime event.
- **Language:** the request's (`?lang=`, `X-Lang`, the user's saved
  language, `Accept-Language`); Arabic is written right to left. Dates in
  the user's time zone, else `APP_TIMEZONE`.
- **Issued documents never change.** The PDF is an attachment of the record
  with `locked: true`: `DELETE /v1/attachments/{id}` answers 409
  `attachment_locked`, and it goes only with its record (deleted for good:
  the nightly sweep removes it, and the completed document's row with it).
  Asking again issues a new document, a new attachment. The rows of
  documents that failed (or never finished) stay after their record is
  purged, without a file: the id, status and reason only.
- **What is in it:** what the requester may read of the record now (the
  worker checks again: someone who lost access meanwhile gets a failed
  document). The document records the record's fields it shows (`fields`:
  notes `title`, `number`, `status`, `createdAt`, `publishedAt`, and `body`
  when the requester may read the text). Downloading its attachment, or
  reading it at `GET /v1/documents/{id}`, takes the right to read **every
  one** of them now (field-level permissions, `AttachmentTarget.canReadFields`):
  a reader without `Note.body` gets a 404 for a PDF that has the text, and
  can ask for their own, without it. The attachment still shows in the
  record's list of attachments.
- **One at a time:** while your document of a record, in a language, is
  queued or rendering, asking for it again answers 409 `document_pending`
  (its `id` in the problem); another language is another document.
- **Errors:** 404 (the record isn't there or isn't yours to read), 403 (the
  source's `canIssue` says no), 409 `document_pending`, 429 `rate_limited`
  (more than 10 a minute from one user; API clients have their quotas),
  503 `documents_unavailable` (no `GOTENBERG_URL`), the idempotency codes.
- **Failures:** a render that times out (`GOTENBERG_TIMEOUT_MS`, 30 s) or
  that Gotenberg fails (5xx, 408, 429, the network) is tried again with
  exponential backoff from 1 s, `DOCUMENTS_RENDER_ATTEMPTS` (3) times in all;
  a page Gotenberg refuses (another 4xx), a record gone and a deactivated
  requester fail at once. A failed document has no attachment and no file.
- Audited: `document.requested`, `document.issued` (with the attachment's
  `attachment.added`), `document.failed`. A user's requests are in their
  data export (`kind: documents`); when their account is deleted the
  documents stay with their records, `requestedBy` becoming `anonymized`.

## For features

A `DocumentSource` registered from its constructor, a template, its labels,
and a route:

```ts
@Injectable()
export class InvoiceDocuments implements DocumentSource {
  readonly name = 'invoice';
  readonly subject = 'Invoice';           // must take attachments (an AttachmentTarget)
  constructor(…, registry: DocumentsRegistry) { registry.register(this); }

  canIssue(principal, id) { … }           // in the request, after the record was found readable: 403 when false
  async content(principal, id, { locale, timezone, issuedAt }) {
    // On the worker, as the requester. NotFoundException: the document fails (no retry).
    return {
      template: 'invoice',                // src/documents/templates/invoice.html (or invoice.<locale>.html)
      title: invoice.number,              // the PDF's title
      fileName: invoice.number,           // the attachment: INV-2026-00042.pdf
      context: { labels: { … }, invoice: { … } },  // values only, formatted for `locale`
    };
  }
}

@Post(':id/pdf')
@HttpCode(HttpStatus.ACCEPTED)
@Idempotent({ required: true, scope: principalScope })
@Can.Anyone() // DocumentsService checks the record
pdf(@CurrentUser() user, @Param('id', ParseUUIDPipe) id, @Ip() ip) {
  return this.documents.request(user, { source: 'invoice', recordId: id, locale: this.i18n.locale, ip });
}
```

**Templates** (`apps/api/src/documents/templates/`, copied to `dist` by
nest-cli.json) use @nestjs/mail's `FileTemplateEngine`, the mails' own
engine: Handlebars' syntax, without helpers.

- `{{ value }}` is HTML-escaped, always. A value is never markup: a title
  `<script>…` prints as text. `{{ }}` anywhere else in a tag (an unquoted
  attribute, between attributes) doesn't compile. `{{{ raw }}}` is for the
  layout's body only (`document-templates.spec.ts` refuses it elsewhere).
- Prepare every value in `content()` (formatted dates and numbers, translated
  labels from `i18n/<locale>/documents.json`); `{{#if}}`, `{{#each}}` and
  partials (`partials/<name>.html`) are the logic there is.
- `layout.html` wraps each one: A4 with margins (`@page`), the fonts,
  `<html lang dir>` (`dir="rtl"` for Arabic, Hebrew, Persian, Urdu…), the
  `<title>`. `unicode-bidi: plaintext` on a block of free text lets each
  paragraph take its own direction (English inside an Arabic document).
- `note.ar.html` next to `note.html` would be used for Arabic: most
  documents need one template and translated labels.
- **Nothing remote:** inline CSS; images and fonts only as `data:` URLs.
  The layout's Content-Security-Policy (`default-src 'none'`) blocks the
  rest, Gotenberg's Chromium may load nothing but the page
  (`--chromium-allow-list=^file:///tmp/`), and its network has no way out
  ([deployment](deployment.md#gotenberg-pdf-documents)): an `<img>` pointing
  at an internal service (SSRF) loads nothing. The spec checks the template
  files for URLs, scripts, links and frames.
- **Fonts:** Gotenberg's image has Noto Sans (Latin, Greek, Cyrillic), Noto
  Sans Arabic and Noto Naskh Arabic, Noto Sans CJK (SC, TC, JP, KR) and Noto
  Color Emoji; the layout lists them in that order, and picks the CJK one
  by `lang`. A brand font goes in as a `data:` URL in `@font-face`.

**How it runs** (`DocumentsService`, `DocumentsProcessor`, queue `documents`):
the request checks, stores the document (`queued`) with its audit entry,
and queues a job whose id is the document's. The worker checks the
requester again, asks the source for the content, renders the HTML, posts
it to Gotenberg (`/forms/chromium/convert/html`, one attempt of
`GOTENBERG_TIMEOUT_MS` per job attempt: the queue retries, not the HTTP
client), and writes the PDF to the private disk.
Then **one transaction** adds the attachment (locked, with its `fields`)
and marks the document `completed` with its audit entries; the realtime
event follows the commit.

- **One PDF per document, whatever runs twice.** Each run claims the
  document with a token of its own (`queued` or `rendering` → `rendering`,
  `run_token`), writes under its own key (`documents/<id>/<token>.pdf`), and
  completes the document only while it still holds the claim. BullMQ can
  run a job twice at once (a stalled job, its worker alive but late, picked
  up again): the later claim wins, the earlier run finds its claim gone at
  the commit, deletes its own file and stops. A run never overwrites or
  deletes another run's file, and an issued PDF never changes.
- **Failing is idempotent:** `fail()` marks a queued or rendering document
  failed and audits it in one transaction, then tells the requester; called
  again (the worker's `failed` event after `issue()`'s own handling, on any
  final failure, a stalled job included), it changes, audits and tells
  nothing. A run deletes its own file when it fails. A run whose worker
  died after writing its file leaves that file behind, with no row
  pointing at it.
- A job run again after its commit finds the document issued and does
  nothing; a failed document is never rendered again.

## Development and tests

- `pnpm services:up` runs Gotenberg on `http://127.0.0.1:3100` (the official
  image with production's flags); `env.development.example` points
  `GOTENBERG_URL` at it. Unset, documents are off and everything else works.
- `apps/api/test/documents.e2e-spec.ts` runs against a stand-in for
  Gotenberg on loopback (it records the page and answers a PDF, a slow PDF,
  a refusal, a failure, or nothing): no Docker pull, no Chromium. It covers
  the job, the attachment, the realtime events, retries, timeouts and
  refusals, field-level checks on download, 409 `document_pending`, a
  document rendered twice at once (one PDF), an idempotent `fail()`, and the
  per-user limit.
- `document-templates.spec.ts`: XSS payloads stay text in every field,
  `dir`/`lang` per language, and the template files load nothing.
- Checking a real render: compare text, never bytes (Chromium stamps
  `CreationDate` and `ModDate`): `pdftotext -layout file.pdf -`, and
  `pdffonts` for the fonts (an Arabic document lists NotoSansArabic).
