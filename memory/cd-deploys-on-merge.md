---
name: cd-deploys-on-merge
description: Production deploy of all 6 workers happens via the ci-cd-main deploy job on merge to main
metadata:
  type: project
---

Production deploys are **not** Cloudflare-native git integration. The `deploy` job in
`.github/workflows/ci-cd-main.yml` (added 2026-07-01, needs test/typecheck/build) runs
`npm run deploy` on every push to `main`, authenticating with the `CLOUDFLARE_API_TOKEN`
/ `CLOUDFLARE_ACCOUNT_ID` Actions secrets. It ships all six workers: channel, item,
delete, profile, oidc-issuer, telemetry-gateway.

Consequence for provisioning scripts: a bare `git push` to a feature branch does NOT
deploy — only merge-to-main does. `provision-account.ts` therefore gates KV-seeding
behind `--seed-kv`: first run commits app-password bindings (→ PR → merge → deploy),
then re-run with `--seed-kv` to seed KV once the bindings are live, avoiding the cron
picking up the channel before its bindings deploy. Unblock the PR via [[ci-review-gate]].
