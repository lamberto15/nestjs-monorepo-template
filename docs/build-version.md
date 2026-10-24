# Deployed build information

The signed-in account menu displays the build commit bundled in the loaded tab, the commit served by the web server at `/version.json`, and the API's commit from `/health/version`. Select **Check version** to compare. A mismatch means the loaded web build differs from the currently served build (including intentional rollback); reload is user-initiated.

CI passes the exact GitHub Actions commit to both API and Caddy Docker builds. The web bundle and version manifest share that source. Production's image digests are pinned independently; web and API can disagree temporarily during rollouts. This is **not** a claim that the running build equals GitHub `main` or the latest release. No remote GitHub requests or background polling occur.

Both Caddy configurations return the manifest with `Cache-Control: no-store`. It is not included in the PWA precache. The API version endpoint discloses only its source SHA and does not alter readiness checks. Local builds without `GIT_SHA`, offline requests and malformed metadata result in an unknown status.
