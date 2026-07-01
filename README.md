# youtube-mirror

Mirror a YouTube channel's **videos, community posts, and comments** to
[Bluesky](https://bsky.app), running on Cloudflare Workers + Workflows.

- **Videos** → a Bluesky post with an external link card (thumbnail → YouTube), with the **description mirrored as a threaded reply chain**.
- **Community posts** → text + images (polls rendered as text).
- **Comments** → threaded Bluesky replies (the channel's own comments on the main account; everyone else's on a companion "RT" account).

Videos and comments are fetched via the **YouTube Data API v3**; community-tab
posts are scraped via **Firecrawl** (the official API has no community endpoint).

Modeled 1:1 on the sibling [`twitter-mirror`](https://github.com/pedropaulovc/twitter-mirror) service.

## Getting started

```bash
npm install
npm run test:all     # lint + typecheck + tests + dry-run build
npm run dev          # local wrangler dev (mirror-channel worker)
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Dry-run deploy every worker config (compile check) |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Unit + integration tests (Vitest under miniflare) |
| `npm run test:all` | Full pre-push check |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` |
| `npm run deploy` | Deploy all workers (needs Cloudflare credentials) |

## Architecture & deployment

See [AGENTS.md](AGENTS.md) for the worker/workflow layout, KV schema, data
sources, and the step-by-step deployment / provisioning guide.
