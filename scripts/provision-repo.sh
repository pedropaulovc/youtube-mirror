#!/usr/bin/env bash
set -euo pipefail

# Provisions a GitHub repo created from the typescript-project template.
# Applies repo settings, branch rulesets, and tag rulesets that templates don't carry over.
# Safe to run multiple times — existing rulesets are updated in place.
#
# Usage:
#   scripts/provision-repo.sh                  # auto-detects repo from git remote
#   scripts/provision-repo.sh owner/repo       # explicit repo

REPO="${1:-}"

if [[ -z "$REPO" ]]; then
  REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null) || {
    echo "Error: could not detect repo. Pass owner/repo as argument." >&2
    exit 1
  }
fi

echo "Provisioning $REPO ..."

# ── Helpers ────────────────────────────────────────────────────────────────────

# Finds an existing ruleset ID by name, or prints empty string.
ruleset_id_by_name() {
  gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$1\") | .id" 2>/dev/null || true
}

# Creates or updates a ruleset. Usage: upsert_ruleset "Name" <<'JSON' ... JSON
upsert_ruleset() {
  local name="$1"
  local body
  body=$(cat)

  local existing_id
  existing_id=$(ruleset_id_by_name "$name")

  if [[ -n "$existing_id" ]]; then
    echo "  Updating ruleset: $name (id $existing_id) ..."
    echo "$body" | gh api "repos/$REPO/rulesets/$existing_id" -X PUT --silent --input -
  else
    echo "  Creating ruleset: $name ..."
    echo "$body" | gh api "repos/$REPO/rulesets" -X POST --silent --input -
  fi
}

# ── Repo settings ──────────────────────────────────────────────────────────────
echo "  Setting merge strategy (merge-only), auto-merge, and head branch cleanup ..."
gh api "repos/$REPO" -X PATCH --silent \
  -f allow_merge_commit=true \
  -f allow_squash_merge=false \
  -f allow_rebase_merge=false \
  -f allow_auto_merge=true \
  -F delete_branch_on_merge=true \
  -F allow_update_branch=true \
  -f merge_commit_title=PR_TITLE \
  -f merge_commit_message=PR_BODY

echo "  ⚠ For the janitor agent (gh-aw) to create PRs, manually enable:"
echo "    Settings → Actions → General → Workflow permissions → Read and write"
echo "    Settings → Actions → General → Allow GitHub Actions to create and approve pull requests"

# ── Human review gate environment ──────────────────────────────────────────────
# Solo-dev workaround: GitHub blocks PR self-approval, but allows self-approval
# on environment deployments. The "Human review gate" workflow targets this
# environment; the ruleset's required_deployments rule blocks merge (including
# auto-merge) until the approver clicks Approve on the deployment.
echo "  Configuring pr-review-gate environment (reviewer = current user) ..."
GATE_REVIEWER_ID=$(gh api user --jq '.id')
gh api "repos/$REPO/environments/pr-review-gate" -X PUT --silent --input - <<JSON
{
  "wait_timer": 0,
  "prevent_self_review": false,
  "reviewers": [
    { "type": "User", "id": $GATE_REVIEWER_ID }
  ],
  "deployment_branch_policy": null
}
JSON

# ── Branch ruleset: Protect main ───────────────────────────────────────────────
upsert_ruleset "Protect main" <<'JSON'
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main"],
      "exclude": []
    }
  },
  "bypass_actors": [
    {
      "actor_id": 5,
      "actor_type": "RepositoryRole",
      "bypass_mode": "pull_request"
    }
  ],
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "allowed_merge_methods": ["merge"],
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_approving_review_count": 0,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "copilot_code_review",
      "parameters": {
        "review_on_push": true,
        "review_draft_pull_requests": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "do_not_enforce_on_create": false,
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "lint" },
          { "context": "typecheck" },
          { "context": "unit-tests" },
          { "context": "e2e-tests" }
        ]
      }
    },
    {
      "type": "required_deployments",
      "parameters": {
        "required_deployment_environments": ["pr-review-gate"]
      }
    },
    {
      "type": "deletion"
    }
  ]
}
JSON

# ── Tag ruleset: Immutable tags ────────────────────────────────────────────────
upsert_ruleset "Immutable tags" <<'JSON'
{
  "name": "Immutable tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/tags/v*"],
      "exclude": []
    }
  },
  "bypass_actors": [],
  "rules": [
    { "type": "update" },
    { "type": "deletion" }
  ]
}
JSON

# ── Release immutability ──────────────────────────────────────────────────────
echo "  Enabling release immutability ..."
gh api "repos/$REPO/immutable-releases" -X PUT --silent

# ── Security settings ──────────────────────────────────────────────────────────
echo "  Enabling secret scanning and push protection ..."
gh api "repos/$REPO" -X PATCH --silent \
  -f security_and_analysis[secret_scanning][status]=enabled \
  -f security_and_analysis[secret_scanning_push_protection][status]=enabled

# ── Copilot agent authentication ──────────────────────────────────────────────
echo "  Configuring Copilot agent authentication ..."

# Check if copilot-requests permission is available (Enterprise Cloud / enrolled orgs).
# Test by checking if the org has Copilot API access.
OWNER="${REPO%%/*}"
COPILOT_REQUESTS_AVAILABLE=false

if gh api "orgs/$OWNER/copilot/billing" --silent 2>/dev/null; then
  COPILOT_REQUESTS_AVAILABLE=true
fi

if [[ "$COPILOT_REQUESTS_AVAILABLE" == "true" ]]; then
  echo "  ✓ copilot-requests permission available (org: $OWNER)."
  echo "    The janitor workflow will use features: copilot-requests: true."
else
  echo "  ✗ copilot-requests permission NOT available for this repo."
  echo "    The janitor workflow requires a COPILOT_GITHUB_TOKEN secret (fine-grained PAT)."

  # Check if secret already exists.
  if gh api "repos/$REPO/actions/secrets/COPILOT_GITHUB_TOKEN" --silent 2>/dev/null; then
    echo "  ✓ COPILOT_GITHUB_TOKEN secret already configured."
  else
    REPO_SHORT=$(echo "${REPO##*/}" | tr '[:lower:]-' '[:upper:]_')
    echo ""
    echo "  Create a fine-grained PAT at: https://github.com/settings/personal-access-tokens/new"
    echo ""
    echo "  Fill in the fields as follows:"
    echo "    Token name:         COPILOT_JANITOR_${REPO_SHORT}"
    echo "    Description:        Copilot CLI for gh-aw janitor"
    echo "    Resource owner:     $OWNER"
    echo "    Expiration:         90 days (or Custom for longer)"
    echo "    Repository access:  Only select repositories → $REPO"
    echo "    Permissions:        Account permissions → Copilot Requests → Access: Read-only"
    echo "                        (leave all other permissions blank)"
    echo ""
    echo "  Click 'Generate token' and paste the value below."
    echo ""
    read -rp "  Paste the token here (or press Enter to skip): " TOKEN

    if [[ -n "$TOKEN" ]]; then
      echo "$TOKEN" | gh secret set COPILOT_GITHUB_TOKEN --repo "$REPO"
      echo "  ✓ COPILOT_GITHUB_TOKEN secret set."
    else
      echo "  ⚠ Skipped. The janitor workflow will fail until COPILOT_GITHUB_TOKEN is configured."
      echo "    Run: echo '<token>' | gh secret set COPILOT_GITHUB_TOKEN --repo $REPO"
    fi
  fi
fi

echo "Done. Rulesets and security settings applied to $REPO."
