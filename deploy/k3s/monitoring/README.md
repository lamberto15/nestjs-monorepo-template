# K3s observability

This directory describes three independent Helm releases in the `monitoring` namespace. The app remains
in `nestjs-monorepo`; installing or rolling back monitoring does not upgrade the app. No cluster changes
are made by CI.

- `monitoring`: `prometheus-community/kube-prometheus-stack` 92.11.0. Prometheus, Grafana and
  Alertmanager PVCs use `local-ssd`.
- `loki`: `grafana-community/loki` 19.1.1 (Loki 3.7.9). Monolithic Loki uses a `local-hdd` PVC and 7-day retention.
- `alloy`: `grafana/alloy` 1.14.3. A DaemonSet reads K3s containerd pod logs and sends them to Loki.

The chart values are pinned and rendered by `.github/workflows/helm.yml`. The chart version and
application version are distinct; CI renders the exact chart versions above.

## Boundaries and storage

K3s already runs Traefik, CoreDNS, metrics-server and the local-path provisioner. This setup does not
install another ingress, DNS server or metrics-server. Kube-state-metrics and node-exporter are
components of kube-prometheus-stack. Monitoring services use ClusterIP only. There are no Ingress or
LoadBalancer objects; use port-forward over Tailscale to access the UI.

The existing local-path classes map `local-ssd` to `/var/lib/rancher/k3s/storage` and `local-hdd` to
`/data/k8s-storage`. Confirm those paths and free space on the actual node before installing. PVC
requested sizes are not enforced quotas. Local-path storage is tied to this node and is not highly
available. A full disk can disrupt K3s, the application and monitoring together. Keep sufficient
filesystem headroom and monitor node disk pressure. PVCs use the cluster's Retain reclaim policy;
deleting a release does not mean its data has been backed up.

Prometheus keeps up to 10 days / 15 GB of metrics; Loki keeps 7 days of logs. The PVC request sizes
(Prometheus 20 GiB, Grafana 5 GiB, Alertmanager 2 GiB, Loki 50 GiB) are planning values, not disk quotas.

## Provision the metrics token out of band

Create one random bearer token with at least 16 characters and store it in the existing app secret and
the monitoring namespace secret. Do not put the token in Helm values or this repository.

- In `nestjs-monorepo`, the existing `app-secrets` Secret must contain the key `metrics_token`. The app's
  `values.single-node.yaml` maps it to `METRICS_TOKEN_FILE` for both API and worker.
- In `monitoring`, create a Secret named `metrics-token` with key `token`. Prometheus Operator reads
  ServiceMonitor authorization credentials from the ServiceMonitor's namespace (`monitoring`).
- Use the same token in both Secrets. Provision/update them through the deployment's protected secret
  manager. If using a local shell for a one-off setup, keep the value in a protected environment variable
  and never pass the literal token in shell history or commit it.

The API and worker `/metrics` endpoints return 404 without the token and require `Authorization: Bearer
…` when enabled. The application's ingress does not route `/metrics`.

## Install or update

First inspect the live cluster and confirm the storage classes, namespace, app release and Secrets:

```sh
kubectl get storageclass local-ssd local-hdd
kubectl get nodes -o wide
kubectl get pvc -A
kubectl get secret app-secrets -n nestjs-monorepo
```

Install kube-prometheus-stack first because its Operator CRDs are required by the app chart's enabled
`PrometheusRule`. Then upgrade the app release with `values.single-node.yaml`; its existing `app-secrets`
Secret must contain `metrics_token`. After the app rollout, install Loki and Alloy and apply the
ServiceMonitors below. CI uses the exact chart versions in these commands:

```sh
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo add grafana-community https://grafana-community.github.io/helm-charts
helm repo update
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -
# Provision metrics-token in monitoring with the protected secret manager, then verify it.
kubectl get secret metrics-token -n monitoring
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --version 92.11.0 \
  -f deploy/k3s/monitoring/kube-prometheus-stack.values.yaml --wait
```

Now upgrade the `app` release with the repository's single-node values profile.
Once that rollout is ready, install Loki and Alloy and register the app targets:

```sh
helm upgrade --install loki grafana-community/loki \
  --namespace monitoring --version 19.1.1 \
  -f deploy/k3s/monitoring/loki.values.yaml --wait
helm upgrade --install alloy grafana/alloy \
  --namespace monitoring --version 1.14.3 \
  -f deploy/k3s/monitoring/alloy.values.yaml --wait
kubectl apply -f deploy/k3s/monitoring/targets/
```

These are independent releases. Do not install them into the app release. Updating the API/worker targets
is a Kubernetes manifest change in `targets/`; the Prometheus selectors only accept objects labelled
`release: monitoring`.

## Access and verify

Forward Grafana to localhost while connected to the cluster over Tailscale:

```sh
kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80
```

Open `http://127.0.0.1:3000`. Read the generated admin password from the `monitoring-grafana` Secret; do
not store it in Git. Find the Prometheus and Alertmanager services with `kubectl get svc -n monitoring`
and port-forward them when needed.

Check the release health and PVC placement:

```sh
helm list -n monitoring
kubectl get pods,svc,pvc -n monitoring -o wide
kubectl get servicemonitor -n monitoring app-api app-worker -o yaml
```

In Prometheus, open **Status → Targets** and confirm `api` has one target per API replica and `worker`
has one target, all `UP`. In **Status → Rules**, confirm the app alert groups are loaded. The rules are
selected by `release: monitoring` from the app chart's `PrometheusRule`.

In Grafana Explore, select Loki and query `{namespace="nestjs-monorepo", container="api"}`. Alloy
discovers pod logs on each node, parses the CRI envelope and labels streams with bounded Kubernetes
metadata (namespace, container, node and component). It does not mount the Docker socket or use request
IDs as labels.

## Rollback and PVC recovery

Roll back each release independently to its previous Helm revision; use `helm history -n monitoring
<release>` to select the revision. Remove or restore the ServiceMonitor manifests separately with
`kubectl apply -f deploy/k3s/monitoring/targets/` or `kubectl delete -f ...`.

```sh
helm history monitoring -n monitoring
helm rollback monitoring <revision> -n monitoring --wait
helm rollback loki <revision> -n monitoring --wait
helm rollback alloy <revision> -n monitoring --wait
```

Avoid `helm uninstall` during rollback. If a PVC is lost or a release is removed, inspect the claim,
retained PV and local-path records before changing anything:

```sh
kubectl get pvc -n monitoring -o wide
kubectl get pv -o wide
kubectl describe pv <retained-pv-name>
```

Record the PV's `claimRef`, StorageClass, node affinity and local path. Preserve or copy the node data
before recovery. Recreate a claim in `monitoring` with the original capacity and access mode, bound to the
retained PV; if the PV is `Released`, have the cluster administrator rebind it after confirming the old
claim no longer exists. Do not delete the PV or node directory while recovering data. Reinstall or upgrade
the release with the same values, then verify Grafana dashboards, Prometheus TSDB and Loki queries before
resuming upgrades. Local-path storage has no automatic off-node recovery; back up data outside the node if
it must survive disk or node loss.

Alert rules are installed and evaluated, but no external Alertmanager notification receiver is configured
here. Add notification credentials through the deployment's secret manager only when an approved provider
configuration is available.
