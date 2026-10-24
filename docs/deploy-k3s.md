# Single-node K3s deployment

This guide describes a single-node K3s deployment. Keep the Kubernetes API
private to your tailnet; Cloudflare Tunnel carries public HTTPS traffic to
Traefik inside the cluster. The production host runs K3s and pulls images; it
needs neither Docker nor a source checkout. Replace each `example.com` value
with a domain you control, and keep cluster addresses and account identifiers
in private configuration. For the separate single-node monitoring stack, see
[the observability runbook](../deploy/k3s/monitoring/README.md).

The checked-in manifests are reviewed on a branch and merged through CI. An
administrator applies infrastructure resources from a workstation with an
admin kubeconfig over Tailscale. GitHub receives only the namespace-scoped
`github-deployer` kubeconfig. In the guided setup, run one server command at a
time and inspect its result before the next one.

## Layout

| Component              | Storage or access      | Owner              |
| ---------------------- | ---------------------- | ------------------ |
| API, worker, web, PDFs | GHCR digests           | `app` Helm release |
| PostgreSQL and Redis   | retained RWO SSD class | administrator      |
| Uploaded files         | retained RWO HDD class | `app` Helm release |
| Backups                | Not configured         | operator decision  |
| Cloudflare Tunnel      | Outbound connector     | administrator      |
| ACME certificate       | DNS-01                 | administrator      |

The local-path provisioner offers `ReadWriteOnce`. The API and worker share the
file claim on this single node. Before adding a second node, move files to an
object store or a genuine shared-volume driver. The 100 GiB claim is a capacity
request, not an expected backup size.

## Prepare infrastructure

1. Confirm the `nestjs-monorepo` namespace and both retained StorageClasses.
2. Create `postgres-secrets` with `postgres_password` and `redis-secrets` with
   `redis_password`. Generate independent random passwords outside Git, and
   keep a secure offline copy.
3. Create `redis-script` from the reviewed
   [`redis/redis.sh`](https://github.com/lamberto15/nestjs-monorepo-template/blob/main/redis/redis.sh).
   Apply [`deploy/k3s/data.yaml`](../deploy/k3s/data.yaml), then wait for both
   StatefulSets and verify the two SSD claims bind. Never delete their claims
   as part of an application rollback.
4. Run the reviewed
   [`create-app-secret.py`](https://github.com/lamberto15/nestjs-monorepo-template/blob/main/deploy/k3s/create-app-secret.py)
   interactively on the cluster host. It reads PostgreSQL and Redis credentials from
   their existing Secrets, prompts for the Resend API key, generates separate
   runtime and maintenance passwords plus four signing/encryption keys, and
   creates `app-secrets` through standard input. Save its six generated values
   in a password manager before confirming the prompt. The Secret has
   `database_url`, `database_owner_url`,
   `database_maintenance_url`, `jwt_secret`, `mfa_encryption_keys`,
   `data_encryption_keys`, `blind_index_keys`, `redis_password`, and
   `mail_api_key`. Use
   separate `app_runtime`, `app`, and `app_maintenance` database URLs. The
   migration Job creates and grants application roles; only that Job receives
   the owner URL through its projected Secret keys. The Redis password matches
   `redis-secrets`.
   Verify your sending domain in Resend. The chart uses
   `MAIL_TRANSPORT=resend` and an example sender address; set the actual
   `MAIL_FROM` in GitHub's protected `production` environment variables. Its
   API key comes only from the `mail_api_key` Secret file.
5. The uploaded-files PVC is production storage, not a backup; it does not
   protect against disk failure, theft, or server loss. Automatic deployment
   does not require optional backup CronJobs. Before storing irreplaceable
   production data, arrange a backup destination and complete a restore drill.
   The reviewed
   [`backups.yaml`](https://github.com/lamberto15/nestjs-monorepo-template/blob/main/deploy/k3s/backups.yaml)
   and [`create-backup-secret.py`](https://github.com/lamberto15/nestjs-monorepo-template/blob/main/deploy/k3s/create-backup-secret.py)
   describe the optional encrypted S3-compatible backup path.

PostgreSQL is initialized with the owner `app` and database `app`, matching the
existing Compose configuration. Redis uses append-only persistence and
`noeviction`, matching [`compose.yaml`](../compose.yaml). Optional S3-compatible
backup Jobs use encrypted, deduplicated restic repositories for database dumps,
Redis RDB, and uploaded files. They are optional and are not installed by
default.

Restoring a database requires both `globals.sql` and `app.dump` from the same
snapshot. Test restoration in a separate database and compare row counts and
application health before replacing production data. Restore uploaded files
from the matching date. For Redis, restore the RDB while Redis is stopped and
decide whether queued work should resume before starting the worker.

## Public HTTPS

Install cert-manager at a pinned current stable version. Create a Cloudflare
API token limited to DNS Edit and Zone Read for your zone and store it as
`cloudflare-dns-token` in the `cert-manager` namespace. Before applying
[`deploy/k3s/cloudflare-issuer.yaml`](../deploy/k3s/cloudflare-issuer.yaml),
replace its `example.com` placeholder with your zone. The app ingress requests
`app-tls` for `app.example.com` through DNS-01. The Cloudflare token is never
in the app namespace.

Create a remotely managed Cloudflare Tunnel and a private `cloudflare-tunnel`
namespace. Put its tunnel token in that namespace as `tunnel-token`, then apply
[`deploy/k3s/cloudflare.yaml`](../deploy/k3s/cloudflare.yaml). Configure one
public route:

| Field              | Value                                               |
| ------------------ | --------------------------------------------------- |
| Hostname           | `app.example.com`                                   |
| Service URL        | `https://traefik.kube-system.svc.cluster.local:443` |
| HTTP Host Header   | `app.example.com`                                   |
| Origin Server Name | `app.example.com`                                   |
| Match SNI to Host  | enabled                                             |
| No TLS Verify      | disabled                                            |

Wait for the certificate before testing the route. Do not create a route or
router forwarding rule for port 6443. Cloudflare connects to the application
only; GitHub deploys through Tailscale.

## GitHub deploy identity

Apply [`deploy/k3s/deployer-rbac.yaml`](../deploy/k3s/deployer-rbac.yaml) as an
administrator. Its ServiceAccount can manage the Helm release resources in
this namespace, including the versioned Secret records Helm uses for release
history. It can only read ReplicaSets for rollout status checks. It cannot
change RBAC, namespaces, nodes, or cluster resources. The namespace contains
app Secrets, so keep the credential only in the protected `production` GitHub
environment. Verify denial of ReplicaSet writes and cluster-wide operations
with `kubectl auth can-i` before storing it in GitHub.

Create a kubeconfig for `github-deployer` with server
`https://<TAILSCALE_K3S_ADDRESS>:6443`, the K3s CA, the ServiceAccount token,
and default namespace `nestjs-monorepo`. Store the complete kubeconfig as the
`K3S_KUBECONFIG` environment secret. Rotate this token if the environment is
compromised or the deployer role changes.

Configure a Tailscale workload identity federation client for the GitHub
repository with the `tag:github-k3s-deploy` tag. Tailnet policy must allow
that tag to reach only your cluster's Tailscale address on TCP port 6443. Store
the client ID and audience as `TS_OAUTH_CLIENT_ID` and `TS_AUDIENCE` in the
`production` environment.
The deploy job has `id-token: write` for this federation and joins as an
ephemeral node.

Set the federated identity issuer to
`https://token.actions.githubusercontent.com`. Use the exact subject claim
for your repository and protected environment. With GitHub's immutable OIDC
subjects, the format is
`repo:<OWNER>@<OWNER_ID>/<REPOSITORY>@<REPOSITORY_ID>:environment:production`.
Grant only the `auth_keys` scope for `tag:github-k3s-deploy`. The production
environment must remain restricted to `main`; the environment name takes the
place of the branch in the default subject claim. Add a tailnet grant from that
tag to your cluster's Tailscale address for `tcp:6443` only. Verify the policy
in the Tailscale console before saving.

Restrict the GitHub `production` environment to `main` and require a reviewer
when available. Protect `main` with PR review and the existing CI and Helm
checks. Add the following deployment-specific values as variables to the
protected `production` environment. The workflow uses these values at deploy
time rather than checking your domain into this repository:

| Variable     | Example value             |
| ------------ | ------------------------- |
| `APP_DOMAIN` | `app.example.com`         |
| `APP_URL`    | `https://app.example.com` |
| `MAIL_FROM`  | `no-reply@example.com`    |

Set `K3S_DEPLOY_ENABLED` to `true` only after the database, certificate, route,
and deploy identity have passed their checks. Backups are optional for
deployment; without them, the cluster has no off-server backup.

## Release and recovery

[`CI`](../.github/workflows/ci.yml) already publishes the three application
images after its checks and scans. Its `deploy-k3s` job waits for those exact
publish jobs, validates their digest outputs, renders the production chart,
and deploys the digests with Helm 4 `--rollback-on-failure`. No runner rebuilds
an image for deployment. The chart runs migrations before starting new pods;
readiness waits for PostgreSQL and Redis. A failed migration or readiness
check fails the release.

On an application failure, inspect `helm history app -n nestjs-monorepo`,
then roll back to the last healthy revision. A rollback changes workloads and
configuration, not PostgreSQL data. Migrations must remain expand/contract
compatible with the preceding release. If data is corrupt, stop writes and
restore the database and files from verified backups; do not expect Helm to
undo a schema or data migration.

The data, backup, tunnel, and cert-manager manifests are intentionally outside
the application release. Do not give their administrative credentials to
GitHub Actions.
