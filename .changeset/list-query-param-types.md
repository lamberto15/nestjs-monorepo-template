---
'@nestjs-monorepo-template/api-client': minor
---

List query parameters are typed from the list's schema on every list, not only those with `@Query({ schema })`: `GET …/comments`, `…/revisions`, `/v1/approvals` and `/v1/notes` (and the lists generated features have) now type `limit` and `page` as `number` (`limit` documented 1 to 100, default 50), a flat enum filter as its values (`status?: 'pending' | 'approved' | …`), `count`, `deleted` and the boolean filters as `'true' | 'false'`. Breaking only for callers that passed strings: `limit: '50'` is now a type error, send `limit: 50` (openapi-fetch serializes it the same). Nothing changes on the wire.
