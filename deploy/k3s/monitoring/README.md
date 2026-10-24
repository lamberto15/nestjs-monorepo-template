# Kubernetes observability (draft, issue #626)

This directory begins the declarative monitoring deployment for the single-node K3s host. **Do not install these values until the remaining items in #626 have been implemented and CI validates the exact Helm chart versions.**

## Inventory and boundaries

- Existing K3s add-ons: Traefik, CoreDNS, metrics-server, local-path provisioner.
- Existing cert-manager and Cloudflare Tunnel: keep them as they are.
- App runs separately in namespace `nestjs-monorepo`. Monitoring must use namespace `monitoring` and independent Helm releases.
- `local-ssd` uses `/var/lib/rancher/k3s/storage`; `local-hdd` uses `/data/k8s-storage`. The K3s `local-path-config` has both paths. Both classes have `Retain` reclaim policy and `WaitForFirstConsumer` binding. Recheck with `kubectl` before installation.
- Single-node local-path storage is not highly available. A PVC's requested storage size is not an enforced disk quota.

## Intended pipeline

```text
NestJS API + worker --Bearer token--> ServiceMonitors -> Prometheus -> Grafana
Kubernetes pod logs -> Grafana Alloy (DaemonSet) -> Loki -> Grafana
```

Kubernetes Alloy **must not** mount the Docker socket. Keep app logs structured, redact secrets before emission, and avoid high-cardinality Loki labels like request IDs. Never expose Grafana, Prometheus, Loki, Alloy, or the application's `/metrics` endpoint through public ingress. Use `kubectl port-forward` over Tailscale when viewing dashboards.

## Planned Helm configuration

- `kube-prometheus-stack.values.yaml`: one Grafana, one Prometheus, Alertmanager, 10-day metrics retention, `local-ssd` persistence.
- `alloy.values.yaml`: collect CRI-formatted pod logs using the Kubernetes discovery API.
- Loki: use the **community-maintained** Loki chart (the Grafana repository chart is for Enterprise Logs). Pin and test a monolithic filesystem-backed chart with `local-hdd` before adding its values.
- Keep this configuration out of the existing app release; upgrading or rolling back the app must not remove monitoring data.

## Rollout blockers (must be resolved before applying)

1. Pin exact, verified Helm chart versions and test template rendering against them; evaluate single-node Loki monolithic storage/retention schema and the current chart's gateway service name.
2. Add Loki values with filesystem persistence, safe retention, and resource budgets; verify all mounts and CRI log parsing on K3s.
3. Add authenticated `ServiceMonitor` discovery of both API and worker, internal-only `/metrics`, and a secret reference for `METRICS_TOKEN`. Existing `PrometheusRule` is off in the single-node app values until selectors/rules are validated.
4. Add CI validation, a smoke-test/runbook, alert delivery configuration, dashboards, and rollback steps.
5. Verify actual free SSD/HDD space, helm ownership, and security/network policy before any deployment.

Follow progress in [#626](https://github.com/lamberto15/nestjs-monorepo-template/issues/626).
