---
name: community-posts-scrape
description: Community posts live at /@handle/posts (not /community) and have no Data API — Firecrawl basic proxy suffices
metadata:
  type: project
---

YouTube community posts have **no official Data API** (read or write) — the v3
revision history removed even "channel discussions" retrieval. Scraping the
channel page's `ytInitialData` is the only route; the codebase does this via
Firecrawl in `worker/firecrawl.ts`.

**The tab moved from `/community` to `/posts`.** The old `/@handle/community`
path now 200s with a "This Community isn't available" stub containing **no**
`backstagePostRenderer` blobs — so `fetchCommunityPosts` silently returned `[]`.
Fixed by scraping `/@handle/posts?hl=en`.

`proxy: "stealth"`/`enhanced` buy **nothing** here — with the correct `/posts`
URL, Firecrawl **`basic`** proxy (1 credit, no cookie) returns all posts.
Stealth was masking the dead URL at ~5× the cost. A `SOCS` consent cookie is
also unnecessary once the URL is right.
