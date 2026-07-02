---
name: telemetry-destinations-shared-account
description: Workers observability destinations are account-level and shared with twitter-mirror; youtube uses its own protobuf-transcoding gateway
metadata:
  type: project
---

Cloudflare **observability destinations** (`/accounts/{id}/workers/observability/destinations`)
are **account-level**, not per-worker or per-project. The account `18ef3246…` hosts both
twitter-mirror and youtube-mirror, so its destinations are shared namespace:

- `azure-appi`, `azure-appi-logs`, `azure-appi-traces` → the **twitter-mirror** gateway
  (`mirror-telemetry-gateway.pedro-18e.workers.dev`), which transcodes OTLP JSON → App
  Insights **Breeze** (`*.in.applicationinsights.azure.com/v2.1/track`).
- `youtube-azure-logs`, `youtube-azure-traces` → the **youtube-mirror** gateway
  (`youtube-mirror-telemetry-gateway.pedro-18e.workers.dev`), added 2026-07-01.

**Trap:** never point youtube workers at the `azure-appi-*` slugs — their telemetry
would land in *twitter's* Azure. Each project references its own slugs in
`observability.logs/traces.destinations`.

**Why the youtube gateway transcodes to protobuf:** Cloudflare Workers observability
exports OTLP **JSON**, but youtube's Azure target is the managed **OTLP/DCR** endpoint
(`managed-ai-…ingest.monitor.azure.com/…/streams/Microsoft-OTLP-{Logs,Traces}/otlp/v1/…`),
which only accepts **protobuf** — `application/json` → **HTTP 415**. So `worker/otlp-protobuf.ts`
encodes JSON→protobuf and the gateway forwards `application/x-protobuf`. twitter-mirror
avoids this because Breeze speaks JSON; the two projects are **not** 1:1 on telemetry.

**How to apply:** the destination's `Authorization: Bearer` header must equal the target
gateway's `INGEST_BEARER` wrangler secret. Logs+traces only (Workers observability emits
no metrics). Verify ingestion by querying Log Analytics `OTelLogs`/`OTelSpans`
(workspace `eca1d18f-ae61-41a7-af6f-a14696551672`). See [[cd-deploys-on-merge]].
