{{- define "app.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "app.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "app.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels of one component; call with (dict "ctx" . "component" "api"). */}}
{{- define "app.selector" -}}
app.kubernetes.io/name: {{ include "app.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "app.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}{{ include "app.fullname" . }}{{- else -}}default{{- end -}}
{{- end -}}

{{/* An image reference: a digest wins over a tag; no tag is an error (never :latest). */}}
{{- define "app.imageRef" -}}
{{- $img := .img -}}
{{- if $img.digest -}}
{{- printf "%s@%s" $img.repository $img.digest -}}
{{- else if and $img.tag (ne $img.tag "latest") -}}
{{- printf "%s:%s" $img.repository $img.tag -}}
{{- else -}}
{{- fail (printf "set an image tag (a commit SHA) or digest for %s; :latest is refused" $img.repository) -}}
{{- end -}}
{{- end -}}

{{- define "app.secretName" -}}
{{- default (printf "%s-secrets" (include "app.fullname" .)) .Values.secret.existingSecret -}}
{{- end -}}

{{/* The environment of api, worker and migrate. Call with (dict "ctx" . "extra" <map> "files" <map>). */}}
{{- define "app.env" -}}
{{- $ctx := .ctx -}}
{{- $env := mergeOverwrite (dict) $ctx.Values.env .extra -}}
{{- $_ := set $env "APP_URL" (printf "%s://%s" $ctx.Values.scheme (required "set domain (the public host)" $ctx.Values.domain)) -}}
{{- if $ctx.Values.redisUrl }}{{ $_ := set $env "REDIS_URL" $ctx.Values.redisUrl }}{{ end -}}
{{- if $ctx.Values.gotenberg.enabled }}{{ $_ := set $env "GOTENBERG_URL" (printf "http://%s-gotenberg:3000" (include "app.fullname" $ctx)) }}{{ end -}}
{{- range $k, $v := $env }}
- name: {{ $k }}
  value: {{ $v | toString | quote }}
{{- end }}
{{- range $k, $key := .files }}
- name: {{ $k }}
  value: {{ printf "/run/secrets/%s" $key | quote }}
{{- end }}
{{- end -}}

{{- define "app.secretMount" -}}
- name: secrets
  mountPath: /run/secrets
  readOnly: true
{{- end -}}

{{- define "app.secretVolume" -}}
- name: secrets
  secret:
    secretName: {{ include "app.secretName" . }}
    defaultMode: 0444
{{- end -}}
