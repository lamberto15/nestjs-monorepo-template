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
Spreadsheet ZIP expansion safeguards remain independent of upload size.

The catalog returns effective `importLimits.maxBytes` and `maxRows`. The API
enforces the byte cap while receiving the file. An accepted job retains its
resolved limits, so a later settings change affects new uploads only. Workers
validate syntax and row count before writing records, including dry runs.
Malformed or over-limit files fail without writing records. Ordinary row
validation errors retain the existing partial-success behavior.

Uploads and validation scratch files remain private. Operators raising limits
must provision temporary disk and worker capacity for concurrent imports.
`IMPORT_TEMP_DIR` defaults to `.data/import-scratch` beside the API. Use a
disk-backed filesystem, not a RAM-backed `/tmp`. Production Compose gives each
worker its own anonymous scratch volume; Helm uses a disk-backed `emptyDir`.
Keep scratch private to one container/process namespace for safe crash recovery.
