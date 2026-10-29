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
{{- if $ctx.Values.customDomains.enabled }}{{ $_ := set $env "CUSTOM_DOMAINS" "on" }}{{ end -}}
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
    secretName: {{ include "app.secretName" .ctx }}
    defaultMode: 0444
    items:
      {{- range $key := sortAlpha (uniq (values .files)) }}
      - key: {{ $key }}
        path: {{ $key }}
      {{- end }}
{{- end -}}

{{/*
The origins the web app may reach for files, space-separated (empty: none);
templates/web-configmap.yaml puts them in its Content-Security-Policy's
connect-src and img-src alike, after 'self', as caddy/entrypoint.sh does with
WEB_FILES_ORIGINS for the Compose stack. With env.STORAGE_DRIVER=s3 the browser
PUTs a direct upload to the bucket (docs/attachments.md, "Direct uploads") and an
<img> follows an attachment's thumbnail to its signed link ("Image renditions"),
which a policy without the origin blocks. Each origin once, from two sources:
- With env.STORAGE_DRIVER=s3 and env.S3_BUCKET, the bucket's origin, the one the
  API's S3 disk signs its URLs for: env.S3_ENDPOINT, or
  https://s3.<env.S3_REGION or AWS_REGION>.amazonaws.com, with the bucket in front
  of the host (virtual-hosted style), or else the host with the bucket's path,
  <scheme>://<host>/<bucket>/ (path style: env.S3_FORCE_PATH_STYLE "on", an IP
  address as the host, or a bucket name that is not a DNS label). Never the bare
  host: on AWS and other shared stores it serves every customer's buckets. The
  PUT goes to /<bucket>/<key>, which the path matches, and CSP ignores a source's
  path after a redirect, so the thumbnail's 302 to the signed link still loads.
  Settings it cannot read fail the render.
- web.filesOrigin: https origins the settings can't tell (a custom domain or a CDN
  in front of the bucket). They go into the policy as written: anything but
  https://host[:port] fails the render.
*/}}
{{- define "app.webFilesOrigins" -}}
{{- $env := .Values.env -}}
{{- $origins := list -}}
{{- if and (eq (toString (default "" $env.STORAGE_DRIVER)) "s3") $env.S3_BUCKET -}}
{{- $bucket := toString $env.S3_BUCKET -}}
{{- $region := toString (default (default "" $env.AWS_REGION) $env.S3_REGION) -}}
{{- $endpoint := toString (default "" $env.S3_ENDPOINT) -}}
{{- if and (not $endpoint) $region -}}
{{- $endpoint = printf "https://s3.%s.amazonaws.com" $region -}}
{{- end -}}
{{- if not (regexMatch "^https?://[A-Za-z0-9._:\\[\\]-]+/?$" $endpoint) -}}
{{- fail "env.STORAGE_DRIVER is s3 and env.S3_BUCKET is set: set env.S3_REGION (or AWS_REGION), or env.S3_ENDPOINT as http(s)://host; the web app's Content-Security-Policy names the bucket's origin" -}}
{{- end -}}
{{- if not (regexMatch "^[A-Za-z0-9._-]+$" $bucket) -}}
{{- fail "env.S3_BUCKET is not a bucket name (letters, digits, dots and dashes)" -}}
{{- end -}}
{{- $scheme := regexReplaceAll "^(https?)://.*$" $endpoint "${1}" -}}
{{- $host := regexReplaceAll "^https?://([^/]+)/?$" $endpoint "${1}" -}}
{{- $forced := has (toString (default "" $env.S3_FORCE_PATH_STYLE)) (list "on" "true") -}}
{{- $ip := or (regexMatch "^\\[" $host) (regexMatch "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+(:[0-9]+)?$" $host) -}}
{{- $label := or (regexMatch "^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$" $bucket) (and (eq $scheme "http") (regexMatch "^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$" $bucket) (not (contains ".." $bucket))) -}}
{{- if or $forced $ip (not $label) -}}
{{- $origins = append $origins (printf "%s://%s/%s/" $scheme $host $bucket) -}}
{{- else -}}
{{- $origins = append $origins (printf "%s://%s.%s" $scheme $bucket $host) -}}
{{- end -}}
{{- end -}}
{{- range splitList " " (default "" .Values.web.filesOrigin | trim) -}}
{{- if . -}}
{{- if not (regexMatch "^https://[A-Za-z0-9.:-]+$" .) -}}
{{- fail (printf "web.filesOrigin: %q is not an https origin (https://host[:port], no path)" .) -}}
{{- end -}}
{{- $origins = append $origins . -}}
{{- end -}}
{{- end -}}
{{- join " " (uniq $origins) -}}
{{- end -}}
