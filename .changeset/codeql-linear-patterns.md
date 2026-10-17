---
"@nestjs-monorepo-template/api-client": patch
---

`createRealtime` trims the URL's trailing slashes in linear time (it used a
regex that was quadratic on a URL of many slashes). The types document the
OIDC callback's query (`code`, `state`, `error`, `iss`), and a custom
field's `validation.pattern` is now described as RE2 syntax: no lookaround,
no backreferences.
