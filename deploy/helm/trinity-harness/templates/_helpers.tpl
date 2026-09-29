{{- define "trinity-harness.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "trinity-harness.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "trinity-harness.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/part-of: trinity-harness
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "trinity-harness.image" -}}
{{- $registry := .global.imageRegistry | default "" -}}
{{- if $registry }}{{ $registry }}/{{ .image.repository }}:{{ .image.tag }}{{ else }}{{ .image.repository }}:{{ .image.tag }}{{- end -}}
{{- end -}}

{{/*
Common pod env: non-secret config from the ConfigMap, secrets from the Secret.
*/}}
{{- define "trinity-harness.envFrom" -}}
envFrom:
  - configMapRef:
      name: {{ include "trinity-harness.fullname" . }}-config
  - secretRef:
      name: {{ include "trinity-harness.fullname" . }}-secret
{{- end -}}

{{/* Hardened container securityContext (docs/design.md §12.3). */}}
{{- define "trinity-harness.securityContext" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
  seccompProfile:
    type: RuntimeDefault
{{- end -}}
