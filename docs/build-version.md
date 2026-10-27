# Deployed build information

The signed-in account menu displays the build commit bundled in the loaded tab, the commit served by the web server at `/version.json`, and the API's commit from `/health/version`. Select **Check version** to compare or **Copy details** to copy full build SHAs. A mismatch means the loaded web build differs from the currently served build (including intentional rollback); reload is user-initiated. If a new PWA service worker is waiting, the menu reuses the application's service-worker activation flow instead of a plain reload.

The image smoke tests assert the manifest SHA equals the GitHub Actions source commit. CI passes the exact GitHub Actions commit to both API and Caddy Docker builds. The web bundle and version manifest share that source. Production's image digests are pinned independently; web and API can disagree temporarily during rollouts. This is **not** a claim that the running build equals GitHub `main` or the latest release. No remote GitHub requests or background polling occur.

Both Caddy configurations return the manifest with `Cache-Control: no-store`. It is not included in the PWA precache. The API version endpoint sends `Cache-Control: no-store`, discloses only its source SHA and does not alter readiness checks. Local builds without `GIT_SHA`, offline requests and malformed metadata result in an unknown status.

## Who can read the commit

`GET /health/version` answers only a signed-in principal (a session, a token client's access token or an API key; 401 otherwise), unlike `/health` and `/health/live` beside it (`core/health/build-version.controller.ts`). The template is public, so an anonymous answer would tell anyone which revision a deployment runs, known-vulnerable ones included. The account menu is shown signed in only and fetches the route from the same origin, so the browser sends the session cookie and the menu works as before; signed out, or for a user who still has to enroll in two-factor or finish onboarding, the API's commit shows as unknown.

Considered and not chosen: `METRICS_TOKEN` (the browser has no such secret, so the menu would lose the API's commit), limiting it to the web app's origin in Caddy (an `Origin` or `Referer` header is set by any client that wants to), and a setting to switch it off (one more option, for an answer only signed-in users need).

The web side stays public by necessity: the bundle every visitor loads embeds the tab's commit, and `/version.json` is a static file Caddy serves before anyone signs in. Those name the web build, which CI builds from the same commit as the API image; while web and API images are pinned independently (a rollout, a rollback of one), the API's own commit is the one only signed-in users see.
