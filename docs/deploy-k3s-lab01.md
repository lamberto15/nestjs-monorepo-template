# lab01 K3s deployment

This is the deployment profile for `nestjs-monorepo.lamby.dev` on the single
K3s node `lab01`. The Kubernetes API stays on Tailscale at `100.87.122.6:6443`.
Cloudflare Tunnel carries public HTTPS traffic to Traefik inside the cluster.
The production host runs K3s and pulls images; it needs neither Docker nor a
source checkout.

The checked-in manifests are reviewed on a branch and merged through CI. An
administrator applies infrastructure resources from a workstation with an
admin kubeconfig over Tailscale. GitHub receives only the namespace-scoped
`github-deployer` kubeconfig. In the guided setup, run one server command at a
time and inspect its result before the next one.

## Layout

| Component              | Storage or access         | Owner              |
| ---------------------- | ------------------------- | ------------------ |
| API, worker, web, PDFs | GHCR digests              | `app` Helm release |
| PostgreSQL and Redis   | `local-ssd`, retained RWO | administrator      |
| Uploaded files         | `local-hdd`, retained RWO | `app` Helm release |
| Encrypted backups      | Off-server S3 bucket      | administrator      |
| Cloudflare Tunnel      | Outbound connector        | administrator      |
| ACME certificate       | DNS-01                    | administrator      |

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
   interactively on lab01. It reads the PostgreSQL and Redis credentials from
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
   Verify `lamby.dev` as a sender domain in Resend. The chart uses
   `MAIL_TRANSPORT=resend` and `MAIL_FROM=no-reply@lamby.dev`; its API key comes
   only from the `mail_api_key` Secret file.
5. Create a private S3-compatible backup bucket, preferably R2 Standard, and
   bucket-scoped credentials. Put its repository base URL, a distinct restic
   encryption password, and the access key pair in `backup-secrets` using the
   keys documented in [`deploy/k3s/backups.yaml`](../deploy/k3s/backups.yaml).
   After the first manual app install creates `app-storage`, apply the backup
   manifests. Run each CronJob once and restore each backup into disposable
   storage. Enable automatic deployment only after the restore drill.

PostgreSQL is initialized with the owner `app` and database `app`, matching the
existing Compose configuration. Redis uses append-only persistence and
`noeviction`, matching [`compose.yaml`](../compose.yaml). The backup Jobs use
encrypted, deduplicated restic repositories for database dumps, Redis RDB, and
uploaded files. The schedule is 03:00, 03:30, and 04:00 Asia/Manila. Fourteen
daily, eight weekly, and six monthly snapshots are retained. This provides a
daily recovery point; it is not point-in-time recovery. Monitor Job failures,
bucket usage, and remaining disk space.

Restoring a database requires both `globals.sql` and `app.dump` from the same
snapshot. Test restoration in a separate database and compare row counts and
application health before replacing production data. Restore uploaded files
from the matching date. For Redis, restore the RDB while Redis is stopped and
decide whether queued work should resume before starting the worker.

## Public HTTPS

Install cert-manager at a pinned current stable version. Create a Cloudflare
API token limited to DNS Edit and Zone Read for `lamby.dev` and store it as
`cloudflare-dns-token` in the `cert-manager` namespace. Apply
[`deploy/k3s/cloudflare-issuer.yaml`](../deploy/k3s/cloudflare-issuer.yaml).
The app ingress requests `app-tls` for `nestjs-monorepo.lamby.dev` through
DNS-01. The Cloudflare token is never in the app namespace.

Create a remotely managed Cloudflare Tunnel and a private `cloudflare-tunnel`
namespace. Put its tunnel token in that namespace as `tunnel-token`, then apply
[`deploy/k3s/cloudflare.yaml`](../deploy/k3s/cloudflare.yaml). Configure one
public route:

| Field              | Value                                               |
| ------------------ | --------------------------------------------------- |
| Hostname           | `nestjs-monorepo.lamby.dev`                         |
| Service URL        | `https://traefik.kube-system.svc.cluster.local:443` |
| HTTP Host Header   | `nestjs-monorepo.lamby.dev`                         |
| Origin Server Name | `nestjs-monorepo.lamby.dev`                         |
| Match SNI to Host  | enabled                                             |
| No TLS Verify      | disabled                                            |

Wait for the certificate before testing the route. Do not create a route or
router forwarding rule for port 6443. Cloudflare connects to the application
only; GitHub deploys through Tailscale.

## GitHub deploy identity

Apply [`deploy/k3s/deployer-rbac.yaml`](../deploy/k3s/deployer-rbac.yaml) as an
administrator. Its ServiceAccount can manage the resource kinds in this one
namespace that Helm owns, including the versioned Secret records Helm uses for
release history. It cannot change RBAC, namespaces, nodes, or cluster
resources. The namespace contains app Secrets, so keep the credential only in
the protected `production` GitHub environment. Verify denial of cluster-wide
operations with `kubectl auth can-i` before storing it in GitHub.

Create a kubeconfig for `github-deployer` with server
`https://100.87.122.6:6443`, the K3s CA, the ServiceAccount token, and default
namespace `nestjs-monorepo`. Store the complete kubeconfig as the
`K3S_KUBECONFIG` environment secret. Rotate this token if the environment is
compromised or the deployer role changes.

Configure a Tailscale workload identity federation client for the GitHub
repository with the `tag:github-k3s-deploy` tag. Tailnet policy must allow
that tag to reach only `100.87.122.6:6443`. Store the client ID and audience
as `TS_OAUTH_CLIENT_ID` and `TS_AUDIENCE` in the `production` environment.
The deploy job has `id-token: write` for this federation and joins as an
ephemeral node.

Restrict the GitHub `production` environment to `main` and require a reviewer
when available. Protect `main` with PR review and the existing CI and Helm
checks. Leave the repository variable `K3S_DEPLOY_ENABLED` unset until the
database, backups, certificate, route, and deploy identity have passed their
checks. Set it to `true` only after the first manual deployment and restore
drill.

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
