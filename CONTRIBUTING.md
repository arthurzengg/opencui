# Contributing to OpenCode Panel

Thanks for considering a contribution! This doc covers the practical bits: how to set up, where things live, how to test, and what a good PR looks like.

## Prerequisites

- **[Bun](https://bun.sh) `1.3.13`** (project pinned via `packageManager` in `package.json`).
- **[opencode](https://opencode.ai)** installed on `PATH` if you want to test end-to-end against a real backend. See the [README's Prerequisites section](./README.md#prerequisites) for install commands per platform.
- **VS Code 1.95+** (matches the `engines.vscode` constraint).

## Setup

```bash
git clone https://github.com/arthurzengg/opencui
cd opencui
bun install
bun run compile         # host esbuild + webview vite
```

Open the folder in VS Code and press `F5` to launch an Extension Development Host with your local build loaded.

## Project layout

`CLAUDE.md` at the repo root has the architectural overview — protocol shape, where chat-host helpers live, the per-turn sticky bubble trick, the abort state machine, the IME guard, etc. **Skim it before making non-trivial changes**; it'll save you 30 minutes of reading source.

Quick map:

```
src/                  extension host (Node) — opencode subprocess, message router, persistence
src/chat/             chat logic split by concern (paths / diff / review / prompt / etc.)
webview/src/          React webview (browser) — components, hooks, the protocol re-export
test/host/            Vitest tests for host helpers (uses a vscode-module mock)
test/webview/         Vitest + RTL component tests
test/integration/     real-VS-Code tests via @vscode/test-electron
```

## Tests

```bash
bun run test              # unit + component + mock-opencode E2E (~5s)
bun run test:watch        # rerun on file change
bun run test:coverage     # writes coverage/index.html
bun run test:integration  # boots a real VS Code (~30s first run)
bun run check-types       # tsc --noEmit on the host side
```

CI runs all four phases on every push and PR (see `.github/workflows/ci.yml`). Your PR will be blocked from merging until CI is green.

To run a single test file:

```bash
bun run test path/to/file.test.ts
bun run test -t "name pattern"
```

## Pull request workflow

1. **Branch from `main`**. Branch names: `feat/<short-desc>`, `fix/<short-desc>`, `docs/<short-desc>`, `refactor/<short-desc>`.
2. **Commit style**: short imperative subject (≤72 chars), optional body explaining *why*. Conventional-commits-ish (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`) is welcome but not required.
3. **Keep PRs focused**. One logical change per PR. Refactor-while-fixing PRs get held up; split them.
4. **Add tests** for new behavior or bug fixes. The reducer + pure helpers are already pattern-friendly (`test/host/`, `test/webview/`). UI tweaks → component tests in `test/webview/*.test.tsx`.
5. **Open the PR**. Use the template; fill in the test plan with concrete steps.
6. **CI must pass** (`Test on ubuntu-latest` status check). Don't force-push to dismiss reviews — push new commits and let stale-approval dismissal handle it.

## Code style

- **No emojis in code or comments** unless the user-facing UX needs one.
- **Don't write comments that just restate what the code does.** Comment WHY when non-obvious — hidden invariants, surprising decisions, references to a past bug.
- **No backward-compatibility shims for code we just wrote.** If a signature changes and all callers are in this repo, change them all; don't keep stale aliases.
- **Match existing test patterns**: pure helpers get their own `*.test.ts`; component tests are `*.test.tsx` using `@testing-library/react`.

## Reporting bugs / requesting features

Use the GitHub issue templates (Bug report / Feature request). For bugs, **include VS Code version, opencode version, and steps to reproduce**. Without these we can't help.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By participating you agree to abide by it.
