// Pure helpers for the YAML ⇄ JSON tool (the conversion itself runs in app/services/devtools/yaml_api.py).

/** 0-based offset of 1-based line:column in text (clamped to the text). */
export function lineColToOffset(text, line, col = 1) {
  const lines = String(text).split('\n');
  const l = Math.min(Math.max(1, line | 0), lines.length);
  let pos = 0;
  for (let i = 0; i < l - 1; i += 1) pos += lines[i].length + 1;
  return pos + Math.min(Math.max(0, (col | 0) - 1), lines[l - 1].length);
}

export const YAML_SAMPLE = `# Helm-style values
replicaCount: 2
image:
  repository: ghcr.io/example/api
  tag: "1.4.2"
defaults: &defaults
  cpu: 250m
  memory: 256Mi
resources:
  requests: *defaults
  limits:
    <<: *defaults
    memory: 512Mi
env:
  - name: LOG_LEVEL
    value: info
  - name: FEATURE_FLAGS
    value: "a,b,c"
---
apiVersion: v1
kind: Service
metadata: { name: api, labels: { app: api } }
`;
