---
name: cd-deploys-on-merge
description: Production and PPE deploy through isolated GitHub Environments in dependency order
metadata:
  type: project
---

Production deployment runs from `.github/workflows/ci-cd-main.yml` after test, typecheck, and build pass on `main`, or by manual dispatch. The deploy job uses the `production` GitHub Environment. PPE uses the `ppe` GitHub Environment and deploys a labeled pull request with schedules forced off.

Both jobs call an environment-specific package script. The script validates the Cloudflare account and resource selectors, synchronizes `OIDC_SIGNING_KEY` and `FIRECRAWL_API_TOKEN` deployment secrets, verifies active Secrets Store metadata and bindings, and deploys issuer, gateway, destinations, item, delete/profile, and channel in that order. The gateway bearer remains an environment secret and is uploaded separately.

ATProto account passwords are backed up in the `youtube-mirror` 1Password vault and retained for account recovery and deprovisioning, then written directly to the selected Cloudflare Secrets Store during provisioning. CI does not receive plaintext passwords; it only verifies that the expected Store metadata and deployed bindings are active. The first provisioning run does not seed KV. After provisioning and deployment have installed and verified the password bindings, run it again with `--seed-kv`. This prevents the channel cron from finding a user record before its bindings exist.
