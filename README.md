# youtube-mirror

`youtube-mirror` copies YouTube videos, community posts, and comments to Bluesky with Cloudflare Workers and Workflows.

- Videos become external cards. Long descriptions continue in a reply chain.
- Community posts keep their text and images. Polls are rendered as text.
- Channel-owner comments use the main Bluesky account. Other comments use a companion RT account.

Videos and comments come from YouTube Data API v3 through GCP Workload Identity Federation. Community posts come from Firecrawl because the official API does not expose them.

## Development

```bash
npm install
npm run test:all
npm run dev
```

| Command | Purpose |
|---|---|
| `npm run build` | Dry-run compile the resource-neutral Wrangler configs |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run TypeScript without emitting files |
| `npm run test` | Run unit and integration tests |
| `npm run config:production` | Render ignored production configs from environment resources |
| `npm run config:ppe` | Render ignored PPE configs from environment resources |
| `npm run cf-typegen:production` | Render production and regenerate Worker bindings |
| `npm run verify:production` | Read-only verification of production resources and live bindings |
| `npm run verify:ppe` | Read-only verification of PPE resources and live bindings |
| `npm run deploy:production` | Deploy production in dependency order; requires authorization |
| `npm run deploy:ppe` | Deploy PPE in dependency order; requires authorization |

There is no generic deploy command. The deploy scripts require an explicit environment and reject missing or mismatched selectors.

## Isolated environments

| Environment | Cloudflare account | GitHub Environment | State and credentials |
|---|---|---|---|
| Production | `c6f17a1f1124bf50cba0f5e495aef9ba` | `production` | Production KV, Secrets Store, OIDC key, gateway bearer, federation providers, origins, destinations, and Bluesky accounts |
| PPE | `b846acaf5be2e542781751bd94a63153` | `ppe` | Independent PPE resources and `-ppe-` Bluesky accounts; no production KV or passwords |

The committed Wrangler files contain the stable Worker and Workflow structure. CI reads resource IDs, workers.dev origins, JWK/kid, federation targets, and schedule state from the selected GitHub Environment. It renders complete files under `.wrangler/deploy`, which Git ignores.

Deployment is ordered: issuer, gateway secret and gateway, observability destinations, item, delete and profile, then channel. Channel is last because its cron activates polling. Secrets Store verification reads every page and waits under one bounded deadline until all required entries are active.

Pull requests deploy to shared cronless PPE only with the `deploy-ppe` label. Removing the label or closing the pull request restores PPE from `main`; cleanup does not delete shared PPE resources.

## Operations

[AGENTS.md](AGENTS.md) contains the resource matrix, required GitHub variables and secret names, provisioning commands, production KV cutover, rollback, verification, and source cleanup. [infra/federation.md](infra/federation.md) covers the production and PPE GCP/Azure federation setup.
