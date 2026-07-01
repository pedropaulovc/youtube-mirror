# YouTube Mirror — Agent Instructions

Mirrors a YouTube channel's **videos, community posts, and comments** to Bluesky
via Cloudflare Workers + Workflows. Built 1:1 on the sibling `twitter-mirror`
architecture. The channel's own content (videos, community posts) goes to a
**main** Bluesky account; other people's comments go to an **RT** account.

## Commands

```bash
npm run dev          # wrangler dev (mirror-channel worker)
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
| `mirror-channel` | `MirrorChannelWorkflow` | `* * * * *` | Poll uploads playlist + community tab, filter already-mirrored, dispatch item workflows; poll comments on recent videos |
| `mirror-item` | `MirrorItemWorkflow` | none (binding) | Mirror a single video / community post / comment (router → handlers) |
| `mirror-delete` | `MirrorDeleteWorkflow` | `0 * * * *` | Detect removed videos, delete their Bluesky posts |
| `mirror-profile` | `MirrorProfileWorkflow` | `0 * * * *` | Sync channel title/description/avatar/banner → Bluesky |
| `mirror-telemetry-gateway` | — | — | OTLP → Azure App Insights forwarder (standalone) |

**Content routing**
- **Video** → main-account post: title + `app.bsky.embed.external` link card (thumbnail → watch URL). The description becomes a **threaded self-reply chain**.
- **Community post** → main-account post: text + up to 4 image embeds; polls rendered as text; overflow text → self-reply chain.
- **Comment** → threaded Bluesky reply. Channel-owner comments post from **main**; everyone else from the **RT** account with an `@author:` prefix (link-facet to their channel). Threaded under the parent item's mirrored post, rooted at the video's post.

## Data sources

- **Videos + comments**: YouTube **Data API v3** (`YOUTUBE_API_KEY`). Uploads-playlist polling (`UC…`→`UU…`, 1 quota unit/call — never `search.list`, which is 100). `videos.list`, `commentThreads.list`.
- **Community posts**: **Firecrawl** (`FIRECRAWL_API_TOKEN`) scraping `youtube.com/@handle/community` — the Data API has no community-post endpoint. Requests **raw HTML only** and parses the page's `ytInitialData` locally (avoids Firecrawl's costly LLM JSON extraction). Best-effort; never blocks video/comment mirroring.

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

## Deployment (requires your credentials — not wired in this repo)

Placeholder IDs live in the `wrangler.mirror-*.jsonc` configs. To go live:

1. Create a KV namespace; put its ID in every `wrangler.mirror-*.jsonc` (`kv_namespaces[0].id`).
2. Create Secrets Store entries and set the store IDs in the configs:
   - `youtube-mirror-youtube-api-key` (YouTube Data API v3 key)
   - `youtube-mirror-firecrawl-api-token` (Firecrawl API token)
   - `youtube-mirror-atproto-password-{channelId}` and `-{channelId}-rt` (Bluesky app passwords) — append one pair per channel to each config's `secrets_store_secrets`.
3. Provision two Bluesky accounts per channel (main + RT).
4. Seed a channel: `scripts/seed-channel.ts` (writes `users:{channelId}`).
5. `npm run cf-typegen` (regenerate types), then `npm run build`, then `npm run deploy`.
6. Telemetry (optional): fill `wrangler.mirror-telemetry-gateway.jsonc` vars with your Azure App Insights + Entra federated-credential settings; set `GATEWAY_SIGNING_KEY` and `INGEST_BEARER` as wrangler secrets; point each worker's `observability.logs/traces.destinations` at the gateway.

## Debugging

```bash
npx wrangler tail mirror-channel                     # live logs
npx wrangler tail mirror-item --status error         # errors only
# Workflow instances API (ACCOUNT_ID + CLOUDFLARE_API_TOKEN):
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workflows/mirror-item/instances?per_page=5" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result[] | {id, status}'
```

All Bluesky post creation logs `tag: "bsky-post"` with `bskyUri`, `channelId`, `itemId`, `kind`, `account` — search logs by the bsky post rkey to trace a post back to its YouTube item.

## Code Conventions

- **TypeScript** strict, no `any` (use `unknown` / structured casts at KV/AT-Protocol boundaries), named exports, `kebab-case.ts` modules.
- **Errors**: let them propagate; validate at system boundaries; steps retry via Cloudflare Workflows.
- **Never** deploy directly to production without the user's authorization.

## Out of scope / known limitations

- No retweet/quote analog (YouTube has none); no DM forwarding (YouTube has no DMs).
- Community-post **comments** aren't in the Data API — only video comments are mirrored (community comments would need extra Firecrawl scraping).
- Deeply-nested comment replies may occasionally defer one cycle if their parent comment hasn't finished mirroring.
- Videos are always external link cards — native Bluesky video upload is avoided (ToS/size/3-min limits).
