---
name: cd-deploys-on-merge
description: Production and PPE deploy through isolated GitHub Environments in dependency order
metadata:
  type: project
---

Production deployment runs from `.github/workflows/ci-cd-main.yml` after test, typecheck, and build pass on `main`, or by manual dispatch. The deploy job uses the `production` GitHub Environment. PPE uses the `ppe` GitHub Environment and deploys a labeled pull request with schedules forced off.

Both jobs call an environment-specific package script. The script validates the Cloudflare account and resource selectors, renders ignored Wrangler configs, synchronizes secrets, verifies active metadata, and deploys issuer, gateway, destinations, item, delete/profile, and channel in that order.

`provision-account.ts` writes ATProto passwords to the selected GitHub Environment. Its first run does not seed KV. After the environment deployment installs and verifies the password bindings, run it again with `--seed-kv`. This prevents the channel cron from finding a user record before its bindings exist.
