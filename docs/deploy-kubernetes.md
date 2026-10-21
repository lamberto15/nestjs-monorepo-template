# Kubernetes (Helm)

The production stack on a Kubernetes cluster: the chart in `deploy/helm/app`
runs the same image as the Compose deployment ([deployment.md](deployment.md)),
with the same settings, secret files and migrations. It is for adopters on a
managed cluster; on one host, [rolling](deploy-rolling.md),
[blue-green](deploy-blue-green.md) or [Swarm](deploy-swarm.md) stay simpler.

| Compose / Swarm                        | The chart                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api` (`APP_ROLE=api`), `API_REPLICAS` | Deployment `-api` (rolling, `maxUnavailable: 0`), Service, HPA on CPU, PodDisruptionBudget                                                                                                                                                                                         |
| `worker` (`node dist/worker`)          | Deployment `-worker`                                                                                                                                                                                                                                                               |
| `migrate` (`node dist/migrate`)        | a Job as a `pre-install,pre-upgrade` hook: a failed migration fails the upgrade, the old version serves                                                                                                                                                                            |
| Caddy (TLS, proxy, static web app)     | an Ingress sends the API's paths (the `@api` list of `caddy/Caddyfile`) to `api` and the rest to `web`; `web` is the published Caddy image serving `/srv/web` over http, with the Caddyfile's security headers. TLS ends at the Ingress (cert-manager); `/metrics` is never routed |
| `gotenberg`                            | Deployment and Service, read-only root, a NetworkPolicy that admits only the worker                                                                                                                                                                                                |
| `*_FILE` Docker secrets                | one Secret mounted at `/run/secrets`; the `secretFiles` values set `X_FILE` to the file                                                                                                                                                                                            |
| `monitoring/prometheus/alerts.yml`     | a `PrometheusRule` (`prometheusRule.enabled`, needs the prometheus-operator CRDs)                                                                                                                                                                                                  |
| PostgreSQL, Redis                      | external: managed services, or charts installed beside this one (below)                                                                                                                                                                                                            |
| Backups (`backup` service)             | not in the chart: use the managed database's backups                                                                                                                                                                                                                               |

## Install

Images are pinned by commit SHA or digest (`:latest` is refused). CI publishes
`ghcr.io/<owner>/<repo>` (the API), `/caddy` and `/gotenberg`
([deployment.md](deployment.md), "Published images").

```bash
kubectl create secret generic app-secrets \
  --from-file=database_url=./database_url \
  --from-file=database_owner_url=./database_owner_url \
  --from-file=jwt_secret=./jwt_secret      # one key per file name in secretFiles

helm upgrade --install app deploy/helm/app --wait \
  --set domain=app.example.com \
  --set image.repository=ghcr.io/<owner>/<repo> --set image.tag=<commit-sha> \
  --set web.image.repository=ghcr.io/<owner>/<repo>/caddy --set web.image.tag=<tag> \
  --set gotenberg.image.repository=ghcr.io/<owner>/<repo>/gotenberg --set gotenberg.image.tag=<tag> \
  --set secret.existingSecret=app-secrets \
  --set redisUrl=redis://redis.example:6379/0 \
  --set ingress.className=nginx --set ingress.tlsSecretName=app-tls
```

Roll back with `helm rollback app`; migrations are expand/contract, so the
old version runs against the new schema ([deployment.md](deployment.md),
"Zero-downtime deploys").

## Configuration

- **Settings:** `env` holds plain variables (the names of `env.example`);
  `api.extraEnv` and `worker.extraEnv` add per-process ones
  (`DATABASE_POOL_MAX`, `NODE_OPTIONS`). Keep `DATABASE_POOL_MAX` times the
  replicas under PostgreSQL's `max_connections`.
- **Secrets:** `secretFiles.common`, `.api`, `.worker` and `.migrate` map a
  variable (`JWT_SECRET_FILE`) to a key of the Secret (`jwt_secret`). The
  defaults are the database URLs and the JWT secret; add the others of
  `compose.prod.yaml` (`MFA_ENCRYPTION_KEYS_FILE`, `CURSOR_KEYS_FILE`, ...) when
  you use them, each key present in the Secret. Use `secret.existingSecret`
  (sealed-secrets, External Secrets); `secret.data` is for trials only.
- **PostgreSQL:** `database_url` is the app role (`app_runtime`),
  `database_owner_url` the owner with `CREATEROLE`, both created and granted
  by `migrate` ([deployment.md](deployment.md), "Database roles"). Redis:
  `redisUrl`, plus `REDIS_PASSWORD_FILE` if it has a password.
- **In-cluster PostgreSQL and Redis:** the chart doesn't bundle them: a
  database in the same release is upgraded and rolled back with the app, which
  is wrong for state. Install a chart beside it (for example Bitnami's
  `oci://registry-1.docker.io/bitnamicharts/postgresql` and `/redis`, pinned
  by version) and put its URLs in the Secret and `redisUrl`.
- **Files:** `STORAGE_DRIVER=s3` (the chart's default) needs nothing in the
  cluster. `local` needs `persistence.enabled` and a ReadWriteMany class.
- **Scaling:** the HPA scales `api` on CPU (`api.autoscaling`); the Service
  uses client-IP affinity because socket.io's long-polling needs one replica
  per client (Caddy's cookie in Compose).
- **Alerts:** `prometheusRule.enabled=true` renders `monitoring/prometheus/alerts.yml`
  as a PrometheusRule (`files/alerts.yml` is its copy: `deploy/helm/sync-rules.sh`
  refreshes it, CI compares). The rules read `job="api"` and `job="worker"`;
  scrape the pods' `/metrics` (`METRICS_TOKEN`) with those job names.

## CI

`.github/workflows/helm.yml` runs on changes to the chart or the rules:
`helm lint --strict`, `helm template` (no `:latest`, the hook present, an
image without a tag refused), the rules copy against the original, and a
**kind** smoke test: the API image is built and loaded, PostgreSQL and Redis
are applied from `deploy/helm/ci/deps.yaml`, the chart is installed (the
migrate hook runs first), `/health` answers, and a second upgrade reruns the
hook on a migrated database. The smoke test leaves out the Ingress, `web`
and Gotenberg (no controller, and their images are not built there).
Helm, kind and kubectl are the runner image's, so no third-party action needs
a SHA pin; the job prints their versions.

## Not covered

No Kubernetes cluster was available while writing the chart, so the first CI
run is its first render. Left out: the backup service, a ServiceMonitor,
Alertmanager, and zero-downtime blue-green (use `helm rollback`).
