# Import limits

Administrators configure `dataTransfer.importMaxMiB` and
`dataTransfer.importMaxRows` in Settings. Values are positive whole numbers.
Defaults are 50 MiB and 1,000,000 data rows; headers are not data rows.
Tenant overrides and operators' platform defaults/enforced values follow the
existing settings permissions and audit rules. No restart is required.

`IMPORT_MAX_BYTES` (52428800) and `IMPORT_MAX_ROWS` (1000000) are the
deployment's ceilings and the values used when no runtime value applies. A
setting may only lower them: a higher value is refused (400
`setting_not_allowed`), and one stored before the ceiling existed is capped
when read. To allow larger imports, raise the environment values and restart.
Reverse proxies may impose a lower request-size limit; configure those separately.
Spreadsheet ZIP expansion safeguards (at most 300 MiB unpacked and 2,000
entries, checked from the zip's directory before it is opened) remain
independent of upload size.

The catalog returns effective `importLimits.maxBytes` and `maxRows`. The API
enforces the byte cap while receiving the file. An accepted job retains its
resolved limits, so a later settings change affects new uploads only. The
worker enforces both limits again while it reads: bytes as the file streams
in, rows as they are read. A file over either limit fails the job with a
message naming the limit. Rows are written in groups as they are read (a dry
run writes nothing), so groups completed before the row that crosses the
limit have already been imported.
Ordinary row validation errors retain the existing partial-success behavior.

Uploads stay private. CSV and JSON stream; an Excel workbook is spooled to
a temporary file and streamed too, except one whose zip entry order exceljs'
streaming reader would misread, or one of several sheets, which is read whole
([data-transfer.md](data-transfer.md)): such a file can still hold up to the
byte limit and what it unpacks to in a worker's memory, so size the worker's
memory (and its temporary disk) for concurrent imports before raising the
limits.
