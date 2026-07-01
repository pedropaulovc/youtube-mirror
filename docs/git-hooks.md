# Git Hooks

This project uses [husky](https://typicode.github.io/husky/) to run automated checks before pushing code.

## What runs

| Hook | What it does |
|------|-------------|
| `pre-commit` | Blocks direct commits to `main` and reserved worktree branches (A–G) |
| `pre-push` | Blocks pushes of worktree branches, checks rebase conflicts against `origin/main` |

## How it works

Husky sets the local git config `core.hooksPath=.husky/_`. That directory contains shims that delegate to the matching script in `.husky/` (e.g. `.husky/pre-push`).

This local setting overrides any global `core.hooksPath` the developer may have configured.

### Git config precedence

| Scope | Setting | Effect |
|-------|---------|--------|
| Local (repo) | `core.hooksPath=.husky/_` | **Active** — set by husky via `prepare` script |
| Global | `core.hooksPath=<user-defined>` | Overridden by local setting |
| System | (not set by default) | — |

To inspect the active hooks path:

```bash
git config --local core.hooksPath   # should print .husky/_
```

## Setup

After cloning and running `npm install`, husky installs automatically via the `prepare` script. No extra steps needed.

If hooks aren't running, re-initialize manually:

```bash
npx husky init
```

## Skipping hooks

Hooks should **not** be skipped. If a check fails, fix the issue before pushing. See [AGENTS.md](../AGENTS.md) for the project's policy on git hooks.

In exceptional cases with explicit authorization:

```bash
git push --no-verify
```
