#!/bin/sh
# Copies the Prometheus rules into the chart (Helm reads files only inside the
# chart); CI fails when the copy differs from monitoring/prometheus/alerts.yml.
set -eu
cd "$(dirname "$0")/../.."
cp monitoring/prometheus/alerts.yml deploy/helm/app/files/alerts.yml
