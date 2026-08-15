---
name: telemetry-destinations-shared-account
description: YouTube observability destinations are account-scoped and isolated between production and PPE
metadata:
  type: project
---

Cloudflare observability destinations are account-level. Production and PPE are in different accounts, so each account owns its own `youtube-azure-logs` and `youtube-azure-traces` slugs. Each pair points to that account's `youtube-mirror-telemetry-gateway` origin and carries that environment's gateway bearer.

Do not point YouTube Workers at destination slugs owned by another service. During source cleanup, delete only the two youtube-prefixed destinations. Leave twitter-mirror and unrelated destinations alone.

Cloudflare exports OTLP JSON. The Azure Monitor OTLP/DCR endpoints accept protobuf, so `worker/otlp-protobuf.ts` converts logs and traces before the gateway forwards them as `application/x-protobuf`. An authenticated request must be confirmed in the selected Azure destination; HTTP success by itself is not proof because a bad bearer can be accepted and dropped.
