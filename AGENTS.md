# YouTube Mirror agent instructions

This service mirrors a YouTube channel's videos, community posts, and comments to Bluesky on Cloudflare Workers and Workflows. Channel content uses a main Bluesky account. Comments from other people use a companion RT account.

## Commands

```bash
npm run dev                    # local channel Worker
npm run build                  # dry-run compile of the resource-neutral configs
npm run lint
npm run typecheck
npm run test
npm run test:all               # lint, typecheck, tests, and build
npm run config:production      # render ignored production configs from environment resources
npm run config:ppe             # render ignored PPE configs from environment resources
npm run cf-typegen:production  # render and regenerate worker-configuration.d.ts
npm run cf-typegen:ppe
npm run verify:production      # read-only account, binding, secret, and issuer checks
npm run verify:ppe
npm run deploy:production      # mutating; use only with explicit authorization
npm run deploy:ppe             # mutating; use only with explicit authorization
```

There is no generic deploy command. `scripts/deploy-environment.ts` validates the environment and runs the required order explicitly.

## Runtime layout

| Worker | Workflow class | Schedule | Job |
|---|---|---|---|
| `youtube-mirror-channel` | `MirrorChannelWorkflow` | every minute when enabled | Poll uploads, community posts, and comments; dispatch item jobs |
| `youtube-mirror-item` | `MirrorItemWorkflow` | none | Mirror one video, community post, or comment |
| `youtube-mirror-delete` | `MirrorDeleteWorkflow` | hourly when enabled | Remove Bluesky posts for deleted videos |
| `youtube-mirror-profile` | `MirrorProfileWorkflow` | hourly when enabled | Sync title, description, avatar, and banner |
| `youtube-mirror-oidc-issuer` | none | none | Publish discovery and the selected environment's public JWK |
| `youtube-mirror-telemetry-gateway` | none | none | Convert OTLP JSON to protobuf and forward it to Azure Monitor |

The channel Worker binds to the other three Workflows. Deploy item before channel. Channel is always last because its minute cron starts polling.

Videos become external link cards, with long descriptions in self-replies. Community posts include text and up to four images. Channel-owner comments use the main account; other comments use the RT account and link the author's channel.

## Data and credentials

Videos and comments come from YouTube Data API v3. Workers get a service-account OAuth token through GCP Workload Identity Federation. Community posts come from Firecrawl's raw HTML response for the channel's `/posts` page. Firecrawl is best effort and must not block video or comment mirroring.

KV keys:

| Prefix | Value |
|---|---|
| `users:{channelId}` | channel handles, password binding names, uploads playlist, and poll settings |
| `mirrored:{channelId}:{itemId}` | Bluesky URI/CID, account, kind, and reply chain |
| `channel-meta:{channelId}` | profile change snapshot |
| `recent:{channelId}:{itemId}` | delete index with metadata and expiry |
| `comment-cursor:{channelId}:{videoId}` | last observed comment time |
| `session:{atProtoAccount}` | cached Bluesky session with expiry |
| `gcp-token:{serviceAccount}` | cached GCP access token with expiry |

## Operational learnings

- Scheduled channel, delete, and profile Workers use the validated `MIRROR_CHANNEL_IDS` deployment variable. They must not call `KV.list` on every cron invocation: the Free-plan KV quota combines write, delete, and list requests at 1,000 per day, so the minute channel cron alone exceeds it.
- The channel cron remains `* * * * *`. `worker/schedule.ts` assigns channels to poll-minute buckets with modulo arithmetic; changing the trigger to `*/30` would starve channels assigned to other buckets. Change stored `pollIntervalMinutes` values when changing poll cadence.
- Cloudflare Observability destination activity is not proof of Azure ingestion. Validate authenticated OTLP logs/traces with unique markers and confirm matching records in the selected Azure destination; HTTP 200 from the gateway can also represent an intentional drop for an invalid bearer.

## Cloudflare account boundaries

| Environment | Account ID | State | Credentials | Worker origins |
|---|---|---|---|---|
| Production | `c6f17a1f1124bf50cba0f5e495aef9ba` | its `KV_NAMESPACE_ID` only | `production` GitHub Environment and its Secrets Store | production `WORKERS_DEV_SUBDOMAIN` |
| PPE | `b846acaf5be2e542781751bd94a63153` | its `KV_NAMESPACE_ID` only | `ppe` GitHub Environment and its Secrets Store | PPE `WORKERS_DEV_SUBDOMAIN` |

The same service and destination names are safe because the accounts are different. Each account owns six Workers, four Workflows, `youtube-azure-logs`, and `youtube-azure-traces`. KV, Secrets Store, workers.dev origins, OIDC keys, gateway bearers, GCP providers, and Azure federated credentials are separate.

Never put production `users:*`, `session:*`, `mirrored:*`, or ATProto passwords in PPE. PPE account provisioning adds `-ppe-` to Bluesky handles, and `seed-channel.ts` refuses PPE handles without it.

The committed Wrangler files contain code and binding structure only. `scripts/render-deploy-configs.ts` reads the selected GitHub Environment and writes complete configs under `.wrangler/deploy/{environment}`. Those files are ignored. It rejects the wrong account, missing or malformed resource IDs, the wrong workers.dev subdomain, a mismatched JWK/kid, the wrong GCP provider suffix, or an unspecified schedule state.

## GitHub Environment contract

Set these variables in both `production` and `ppe`:

- `CLOUDFLARE_ACCOUNT_ID`
- `KV_NAMESPACE_ID`
- `SECRETS_STORE_ID`
- `WORKERS_DEV_SUBDOMAIN`
- `OIDC_ISSUER_URL`
- `TELEMETRY_GATEWAY_ORIGIN`
- `OIDC_SIGNING_KID`
- `OIDC_PUBLIC_JWK`
- `GCP_WORKLOAD_PROVIDER`
- `GCP_SERVICE_ACCOUNT`
- `AZURE_TENANT_ID`
- `AZURE_APP_CLIENT_ID`
- `OTLP_TRACES_ENDPOINT`
- `OTLP_METRICS_ENDPOINT`
- `OTLP_LOGS_ENDPOINT`
- `MIRROR_CHANNEL_IDS`
- `ENABLE_SCHEDULES`, exactly `true` or `false`

Set these secrets separately in both environments:

- `CLOUDFLARE_API_TOKEN`
- `OIDC_SIGNING_KEY`
- `FIRECRAWL_API_TOKEN`
- `GATEWAY_INGEST_BEARER`

Secret sources:

- Create a new OIDC keypair and gateway bearer for each environment. The private key and bearer are write-only operational secrets.
- `FIRECRAWL_API_TOKEN` comes from the 1Password environment `bykx5xzmykwxw3of4gtncs7i7`.
- Back up each ATProto account password in the `youtube-mirror` 1Password vault and retain that backup for account recovery and deprovisioning. Write the password directly to the selected Cloudflare Secrets Store during account provisioning. PPE uses its own accounts and passwords; CI does not receive plaintext ATProto passwords.
- Create one token per Cloudflare account. Grant Workers Scripts Write, Workflows Write, Workers KV Storage Read/Write, Secrets Store Read/Write, Workers Observability Write, and Account Settings Read. Do not retain repository-level Cloudflare credentials after cutover.

Never print secret values. Before the first write, the deployment derives the public key from `OIDC_SIGNING_KEY` and requires it to match `OIDC_PUBLIC_JWK`. Deployment sync handles `OIDC_SIGNING_KEY` and `FIRECRAWL_API_TOKEN` from GitHub for now; ATProto passwords are written to the selected Secrets Store during provisioning instead. The gateway bearer remains a GitHub Environment secret and is uploaded separately with `wrangler secret bulk --config` after setting the selected `CLOUDFLARE_ACCOUNT_ID`. CI verifies the Store's active metadata and deployed bindings without receiving plaintext ATProto passwords. It polls the full paginated inventory under one 60-second deadline until every required entry is active; do not use Wrangler Action's generic secret helper for this custom config.

## Deployment and PPE cleanup

A push to `main` uses the `production` GitHub Environment. Set `ENABLE_SCHEDULES=false` during migration. Set it to `true` only when the production state copy has passed its final comparison.

A pull request deploys to shared PPE only when it has the `deploy-ppe` label. Pull-request deployments force schedules off. When the label is removed or the pull request closes, `ci-cd-pr-clean.yml` checks out `main` and restores shared PPE. It never deletes shared PPE Workers, Workflows, KV, or Secrets Store resources.

The deployment order is fixed:

1. verify account, KV, Secrets Store, workers.dev subdomain, origins, JWK, kid, and environment;
2. synchronize Secrets Store entries and wait for active metadata;
3. deploy and verify the OIDC issuer;
4. upload the gateway bearer and deploy the gateway;
5. create or update the two observability destinations;
6. deploy item;
7. deploy delete and profile;
8. deploy channel last;
9. verify live bindings, Secrets Store status, and issuer again.

## Production cutover and rollback

1. Finish PPE first. Use only PPE Bluesky accounts and an empty PPE KV namespace.
2. Provision production resources with `ENABLE_SCHEDULES=false` and deploy all dependencies.
3. Copy source KV while the source poller is live. Preserve values, metadata, and absolute expiration. You may omit `session:*` and `gcp-token:*` so the target reauthenticates, but record that choice.
4. Compare total key count and counts for `users`, `mirrored`, `channel-meta`, `recent`, and `comment-cursor`.
5. Disable source channel, delete, and profile schedules. Wait until all source Workflow instances are terminal. Do not terminate healthy item jobs.
6. Run a final delta copy and compare durable values plus `recent` metadata and expiry.
7. Set production `ENABLE_SCHEDULES=true` and run the production workflow. Item deploys first; channel enables polling last.
8. Watch at least one minute poll and one hourly boundary. Confirm the source creates no new Workflow instances.

Rollback: set target schedules false, wait for target Workflows to finish, review records created after cutover, delta-copy approved target changes back, then re-enable the source. Never run source and target pollers together.

## Verification and source cleanup

```bash
gh variable list --env production
gh variable list --env ppe
gh secret list --env production
gh secret list --env ppe
npm run verify:production
npm run verify:ppe
```

Also confirm six Worker services, four Workflow definitions and classes, the expected cron set, an authenticated OTLP logs/traces round trip, GCP token exchange, Firecrawl access, and both Bluesky logins. Trigger channel, delete, and profile with a seeded `channelId`. Trigger item with an already mirrored video and require no duplicate post.

After the observation window, export an encrypted source KV backup and a key-count manifest. Wait for all source Workflow instances to finish, then remove the four youtube-mirror Workflows and six youtube-mirror Workers. Remove only the `youtube-azure-logs` and `youtube-azure-traces` destinations. Other destination slugs belong to other services. Remove only youtube-mirror entries from the shared source Secrets Store, then delete the old youtube-mirror KV namespace after target validation. Retire the old youtube-mirror GCP provider and Azure credential last. Remove repository-level source Cloudflare secrets and variables.

## Local credentials

Scripts that call Cloudflare use `ensureOpEnv(...)`. It loads a gitignored `.env.local` containing `OP_SERVICE_ACCOUNT_TOKEN`, then re-executes under the 1Password environment when needed. The file wins over a stray shell value.

```text
OP_SERVICE_ACCOUNT_TOKEN=ops_...
```

Manual mutating scripts require `--environment production|ppe`. Deprovisioning also requires `--confirm-account` with the exact selected account ID.

## Code and test conventions

TypeScript is strict. Do not use `any`; validate unknown data at boundaries. Keep names kebab-case and exports named where practical. Let real errors propagate so Workflow retries work.

Integration tests mock network work at the Workflow step boundary with `introspectWorkflowInstance`. Each integration test that imports the Worker entry module must mock `@atproto/api` first.

Do not deploy production without explicit authorization.
