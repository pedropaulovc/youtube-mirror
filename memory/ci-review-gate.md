---
name: ci-review-gate
description: How to unblock the pr-review-gate "Human review gate" that stalls every PR to main
metadata:
  type: project
---

Every PR to `main` in this repo is gated by a **"Human review gate"** GitHub Actions
workflow (`.github/workflows/pr-review-gate.yml`) that deploys a `pr-review-gate`
environment requiring manual approval — CI shows `Awaiting human review: pending`
and the PR will not merge until it's approved.

**Approve it programmatically** (no browser needed):

```bash
runid=$(gh run list --branch <branch> --workflow "Human review gate" --limit 1 --json databaseId -q '.[0].databaseId')
envid=$(gh api repos/pedropaulovc/youtube-mirror/actions/runs/$runid/pending_deployments -q '.[0].environment.id')
echo "{\"environment_ids\":[$envid],\"state\":\"approved\",\"comment\":\"...\"}" \
  | gh api --method POST repos/pedropaulovc/youtube-mirror/actions/runs/$runid/pending_deployments --input -
```

`environment_ids` MUST be a JSON integer array via `--input -` — passing
`-f environment_ids[]=<id>` sends a string and 422s. Standard flow: `gh pr create`
→ `gh pr merge <n> --merge --auto` → approve the gate → it merges when checks pass.
Deploy to production happens on merge to main (see [[cd-deploys-on-merge]]).
