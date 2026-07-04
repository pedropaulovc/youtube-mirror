# YouTube Mirror — Agent Instructions

Mirrors a YouTube channel's **videos, community posts, and comments** to Bluesky
via Cloudflare Workers + Workflows. Built 1:1 on the sibling `twitter-mirror`
architecture. The channel's own content (videos, community posts) goes to a
**main** Bluesky account; other people's comments go to an **RT** account.

## Commands

```bash
npm run dev          # wrangler dev (youtube-mirror-channel worker)
npm run build        # dry-run deploy every wrangler.mirror-*.jsonc (compile check)
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run test         # vitest run (unit + integration, under miniflare)
npm run test:all     # REQUIRED before push: lint + typecheck + test + build
npm run cf-typegen   # regenerate worker-configuration.d.ts after editing a wrangler config
```

> Coverage (`v8`/`istanbul`) is **unsupported** under `@cloudflare/vitest-pool-workers`
> (needs `node:inspector/promises`, absent in the Workers runtime). We gate on
> `vitest run`, not coverage %.

## Architecture — 4 workers (+ telemetry gateway)

| Worker | Workflow class | Cron | Purpose |
|--------|---------------|------|---------|
| `youtube-mirror-channel` | `MirrorChannelWorkflow` | `* * * * *` | Poll uploads playlist + community tab, filter already-mirrored, dispatch item workflows; poll comments on recent videos |
| `youtube-mirror-item` | `MirrorItemWorkflow` | none (binding) | Mirror a single video / community post / comment (router → handlers) |
| `youtube-mirror-delete` | `MirrorDeleteWorkflow` | `0 * * * *` | Detect removed videos, delete their Bluesky posts |
| `youtube-mirror-profile` | `MirrorProfileWorkflow` | `0 * * * *` | Sync channel title/description/avatar/banner → Bluesky |
| `youtube-mirror-telemetry-gateway` | — | — | OTLP JSON→protobuf transcoder + Azure Monitor DCR forwarder (standalone; per-signal, Entra-bearer) |

**Content routing**
- **Video** → main-account post: title + `app.bsky.embed.external` link card (thumbnail → watch URL). The description becomes a **threaded self-reply chain**.
- **Community post** → main-account post: text + up to 4 image embeds; polls rendered as text; overflow text → self-reply chain.
- **Comment** → threaded Bluesky reply. Channel-owner comments post from **main**; everyone else from the **RT** account with an `@author:` prefix (link-facet to their channel). Threaded under the parent item's mirrored post, rooted at the video's post.

## Data sources

- **Videos + comments**: YouTube **Data API v3**, authenticated with a service-account OAuth token via GCP Workload Identity Federation (no static API key — see `infra/federation.md` and `worker/gcp-token.ts`). Uploads-playlist polling (`UC…`→`UU…`, 1 quota unit/call — never `search.list`, which is 100). `videos.list`, `commentThreads.list`.
- **Community posts**: **Firecrawl** (`FIRECRAWL_API_TOKEN`) scraping `youtube.com/@handle/posts` (YouTube renamed the tab from `/community`; the old path now 200s with a "This Community isn't available" stub) — the Data API has no community-post endpoint. Requests **raw HTML only** and parses the page's `ytInitialData` locally (avoids Firecrawl's costly LLM JSON extraction). Best-effort; never blocks video/comment mirroring.

## KV Schema

| Key | Value |
|---|---|
| `users:{channelId}` | `ChannelConfig` (main + rt creds, handle, uploadsPlaylistId, toggles) |
| `mirrored:{channelId}:{itemId}` | `MirroredRecord` (itemId = videoId \| postId \| commentId; bskyUri/cid, account, kind, chainUris?) |
| `channel-meta:{channelId}` | change-detection snapshot |
| `recent:{channelId}:{itemId}` | delete-index entry (self-expiring TTL, metadata = {bskyUri, account}) |
| `comment-cursor:{channelId}:{videoId}` | last-seen comment timestamp (incremental polling) |
| `session:{atProtoAccount}` | cached Bluesky session (TTL) |

## Project Structure

**Entry points**: `worker/mirror-{channel,item,delete,profile}.ts` — each exports its workflow class; channel/delete/profile have cron `scheduled()` handlers.

**Orchestration**: `worker/workflow.ts` (`MirrorChannelWorkflow`), `worker/item-workflow.ts` (`MirrorItemWorkflow` router → handlers).

**Handlers** (strategy pattern): `worker/handlers/context.ts` (`MirrorContext` + `buildContext` DI factory: `getClient`, `getMirrored`, `storeMirrored`, `postChain`, `uploadImages`, `buildVideoCard`), `handlers/{video,community,comment}.ts`.

**Data**: `worker/youtube-api.ts` (Data API v3 client + normalizers), `worker/firecrawl.ts` (community scrape), `worker/content.ts` (classification, grapheme-aware text chunker, poll rendering).

**Shared**: `worker/{constants,types,kv,log,step,text,cron-dispatch,schedule,handles}.ts`, `worker/bluesky.ts` (AT Protocol client).

**Other workflows**: `worker/delete-workflow.ts`, `worker/profile-sync-workflow.ts`. **Telemetry**: `worker/telemetry-gateway.ts`.

**Tests**: `test/unit/{content,youtube-api,firecrawl,schedule,bluesky-client}.test.ts`, `test/integration/{item-workflow,channel-workflow}.test.ts`, factories in `test/helpers/factories.ts`.

## Testing notes

- Integration tests use `introspectWorkflowInstance` + `instance.modify(m => m.mockStepResult(...))` — the workflow runtime does NOT honor `vi.mock`, so step results (which call the real Bluesky/YouTube APIs) are mocked at the step boundary.
- Each integration test file must `vi.mock("@atproto/api", ...)` at the top: the worker's main module imports `@atproto/api`, which crashes on import in the Workers test runtime.
- **Prove tests fail first** (TDD or temporarily break the code) — a test that never failed is untrustworthy.

## Local credentials (`op`)

Scripts that touch production (`provision-account`, `deprovision-account`, `seed-channel`,
`mirror-item`) read `CLOUDFLARE_API_TOKEN` / `FIRECRAWL_API_TOKEN` from the 1Password
environment `bykx5xzmykwxw3of4gtncs7i7i`. They call `ensureOpEnv(...)` (`scripts/op-bootstrap.ts`),
which **auto-sources `.env.local`** for `OP_SERVICE_ACCOUNT_TOKEN` and then re-execs the
script under `op run --environment …` — so you don't prefix commands with `op run` yourself.

Requirement: create a gitignored **`.env.local`** at the repo root holding the service-account
token that can read that environment:

```
OP_SERVICE_ACCOUNT_TOKEN=ops_…
```

`.env.local` wins over any ambient `OP_SERVICE_ACCOUNT_TOKEN` (a stray shell value points at
the wrong account and makes every `op` call fail with "An unexpected error occurred"). When
`.env.local` is absent (e.g. CI injecting the token as a secret), the ambient env is used as-is.

## Deployment (requires your credentials — not wired in this repo)

Placeholder IDs live in the `wrangler.mirror-*.jsonc` configs. To go live:

1. Create a KV namespace; put its ID in every `wrangler.mirror-*.jsonc` (`kv_namespaces[0].id`).
2. Create Secrets Store entries and set the store IDs in the configs:
   - `youtube-mirror-oidc-signing-key` (RSA private key for federation; bound as `OIDC_SIGNING_KEY` in the content workers + gateway — the YouTube Data API uses GCP WIF, not an API key)
   - `youtube-mirror-firecrawl-api-token` (Firecrawl API token)
   - `youtube-mirror-atproto-password-{channelId}` and `-{channelId}-rt` (Bluesky app passwords) — append one pair per channel to each config's `secrets_store_secrets`.
3. Provision two Bluesky accounts per channel (main + RT), and the GCP + Azure federation resources (`infra/federation.md`).
4. Seed a channel: `scripts/seed-channel.ts` (writes `users:{channelId}`).
5. `npm run cf-typegen` (regenerate types), then `npm run build`, then `npm run deploy`.
6. Telemetry (optional): Cloudflare Workers observability emits OTLP **JSON** (logs + traces), but Azure Monitor's managed OTLP/DCR ingestion endpoints only accept **protobuf** (`application/json` → HTTP 415). The gateway (`worker/otlp-protobuf.ts`) transcodes JSON→protobuf and forwards to Azure Monitor's DCR endpoints (`OTLP_{TRACES,LOGS}_ENDPOINT`), authenticating with an Entra bearer minted via federated credentials. Fill `wrangler.mirror-telemetry-gateway.jsonc` vars with your `TENANT_ID`/`APP_CLIENT_ID`/`OIDC_ISSUER_URL` + the DCR endpoint URLs; bind `OIDC_SIGNING_KEY` from the Secrets Store and set `INGEST_BEARER` as a wrangler secret. Create account-level observability destinations (`youtube-azure-logs`/`youtube-azure-traces`) whose URL is the gateway's `/v1/{logs,traces}` and whose `Authorization: Bearer` header matches `INGEST_BEARER`; the four content workers reference those slugs in `observability.logs/traces.destinations`. (Metrics are not emitted by Workers observability, so `/v1/metrics` is unwired.)

## Debugging

```bash
npx wrangler tail youtube-mirror-channel                     # live logs
npx wrangler tail youtube-mirror-item --status error         # errors only
# Workflow instances API (ACCOUNT_ID + CLOUDFLARE_API_TOKEN):
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workflows/youtube-mirror-item/instances?per_page=5" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result[] | {id, status}'
```

All Bluesky post creation logs `tag: "bsky-post"` with `bskyUri`, `channelId`, `itemId`, `kind`, `account` — search logs by the bsky post rkey to trace a post back to its YouTube item.

**Production logs in Azure (via the telemetry gateway).** Logs/traces land in the
Application Insights component `ai-youtube-mirror-wu2` (rg `rg-youtube-mirror-wu2`),
backed by an auto-created **managed** Log Analytics workspace
(`managed-ai-youtube-mirror-wu2-ws`) — *not* a standalone workspace. Query it by App ID
with the **classic** table names (`traces`/`requests`/`dependencies`/`exceptions`), not the
workspace-mode `App*` names. The structured worker log is the `traces.message` field itself
(JSON with `tag`, `message`, `itemId`, …); Cloudflare metadata is in `customDimensions`.

```bash
az login --tenant 6f10d2eb-7cce-444c-bf11-d6fe61d7b8f8   # AppId: 2f35dfeb-4f9e-4501-aea7-06b2dc3b6c65
APP=2f35dfeb-4f9e-4501-aea7-06b2dc3b6c65
# recent errors/warnings across all workers
az monitor app-insights query --app "$APP" --analytics-query \
  "traces | where timestamp > ago(1h) and severityLevel >= 2 | project timestamp, cloud_RoleName, message"
# trace a YouTube item end-to-end (scrape → item workflow → bsky-post)
az monitor app-insights query --app "$APP" --analytics-query \
  "traces | where message has '<itemId>' | project timestamp, cloud_RoleName, message | order by timestamp asc"
```

## Code Conventions

- **TypeScript** strict, no `any` (use `unknown` / structured casts at KV/AT-Protocol boundaries), named exports, `kebab-case.ts` modules.
- **Errors**: let them propagate; validate at system boundaries; steps retry via Cloudflare Workflows.
- **Never** deploy directly to production without the user's authorization.

## Out of scope / known limitations

- No retweet/quote analog (YouTube has none); no DM forwarding (YouTube has no DMs).
- Community-post **comments** aren't in the Data API — only video comments are mirrored (community comments would need extra Firecrawl scraping).
- Deeply-nested comment replies may occasionally defer one cycle if their parent comment hasn't finished mirroring.
- Videos are always external link cards — native Bluesky video upload is avoided (ToS/size/3-min limits).
