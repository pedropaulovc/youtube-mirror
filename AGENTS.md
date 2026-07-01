# TypeScript Project

## Commands

```bash
npm run dev              # Development server
npm run build            # Production build
npm run lint             # ESLint
npm run typecheck        # TypeScript type checking
npm run test             # Unit/integration tests (Vitest)
npm run test:coverage    # Tests with coverage
npm run test:e2e         # Playwright E2E tests
npm run test:all         # REQUIRED before push (lint + typecheck + coverage + e2e)
```

If any command fails, try `npm install` first.

## Testing

### Exit Criteria

- **Any changes:** `npm run test:all` must pass.
- **New features:** Unit tests + integration tests + 1-2 E2E tests + manual sanity check.

### Prove Tests Work

Tests that have never failed are useless. Confirm each test catches what it should: use TDD, or temporarily revert your change and verify the test fails. Include failure validation in commit messages.

### Running Specific Tests

```bash
npm run test -- SomePattern          # by file pattern
npm run test -- -t "should do X"     # by test name
```

### Test Organization

- One `describe()` per file. No `test.skip()` — use directory structure instead.

### E2E Debugging

- **5s max per test case.** 1 minute Bash timeout for full suite.
- **No flaky tests.** Investigate and fix failures. Never dismiss as "unrelated to my changes".
- **`waitForTimeout` is banned** (ESLint rule). Use `waitForSelector`, `waitForFunction`, `waitForLoadState`, `waitForURL`, or `waitForEvent`.
- **Prefer locators over selectors** — they auto-retry and adapt to DOM changes.
- **Use traces, don't guess.** Fetch the `trace.zip` from the CI/CD build outputs or the local test output folder and run `npx playwright-trace-llm path/to/trace.zip -o ./trace-export` to export it to LLM-friendly Markdown and HTML — full action timeline, DOM snapshots, errors with stack traces, console, and network. It contains everything in the Playwright trace viewer.
- **Stress-tested on main.** Every push runs E2E 10x parallel + 10x sequential. Check ci-cd-main workflow history.

## Manual Testing

Use playwright-cli skill **in headed mode only**. Use sparingly:
- Stuck reproducing a bug — `evaluate` captures runtime info (computed styles, side effects).
- Sanity check at ~200 lines of changes to avoid compounding errors.
- Final QA before claiming completion. Test it yourself before asking the user.

## Shared Environment

Multiple Claude Code instances run in parallel. Each worktree gets a designated port: A=3010, B=3020, C=3030, D=3040, E=3050, F=3060, G=3070. `npm run dev` kills only zombie servers for your worktree and starts on the correct port. **DO NOT** kill all node.exe or kill by port. If `npm run dev` fails, ask the user.

## Code Conventions

- **TypeScript**: Strict mode, no `any` (use `unknown`), named exports, `@/` path aliases.
- **Files**: `kebab-case.ts` for modules, `PascalCase.tsx` for components.
- **Icons**: `lucide-react` only.
- **Errors**: Let them propagate. Validate at system boundaries. Use Error Boundaries/Toasts in UI.

## Git Workflow

- **Merge only** (`gh pr merge --merge`). Squash and rebase merge are disabled.
- **Strict up-to-date**: PRs must be current with `main` before merging.
- **Rebase to update**: `git pull --rebase origin main`. Never merge `main` into your branch.
- **Never bypass branch policies** (`--admin`, etc.) or **git hooks** (`--no-verify`). Fix the underlying issue. Only bypass with explicit user authorization.

## Agent Standards

- **Read before coding**: Read relevant specs and source files first.
- **Fix, don't suppress**: No `// eslint-disable` — fix the root cause. No deleting tests — fix the test or the code.
- **One task at a time.** Update task tracking in real-time.
- **Types**: Check `src/types/` first. Use `@/` imports.
- **Verify**: Run `npm run build` + `npm run lint` after significant changes. Visual check with Playwright before claiming done. `gh run watch <run-id>` must be green.
- **Test data**: Use factories in `src/tests/factories/`.
