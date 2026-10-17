---
'@nestjs-monorepo-template/api-client': patch
---

A field the caller may read on some records only (a grant with conditions)
can no longer be filtered, sorted or searched by (`q`, `sort=-rank`): 403
`field_forbidden`, as for a hidden field; `fields=` still picks it.
`GET /v1/lists/{subject}` describes such a field with no `operators`, not
`sortable`, and `search: false` when the search reads one. A sorted list's
`nextCursor` is now sealed by the server (opaque, bound to its `sort`): a
cursor issued before the upgrade, or changed, is a 400; start again from the
first page.
