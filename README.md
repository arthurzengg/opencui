# OpenCUI

A local VS Code AI assistant powered by [opencode](https://github.com/sst/opencode).

It is **decoupled** from opencode at runtime: this extension only talks to the
opencode HTTP server through `@opencode-ai/sdk`. opencode internals are never
imported.

## Features

### Chat
- **Sidebar chat panel** with workspace context, streaming responses, reasoning blocks, and a tool-call trace inline in the conversation.
- **Sticky user message** — your most recent question pins to the top of the messages area while the AI streams its answer (Claude.ai / ChatGPT-style "section header").
- **Edit + regenerate previous prompts** — click any past user message to revise it; the conversation rewinds via `session.revert` (file effects rolled back too) and the AI re-answers from there.
- **Inline thinking indicator** with a shimmering text-gradient animation while the AI is producing its first token.
- **Welcome screen** with one-click suggestion prompts ("Explain this file", "Find bugs in the current file", etc.).
- **Inline edit** (`Cmd+K` / `Ctrl+K`) — rewrite the selection with a natural-language instruction.

### Status bar
- **Combined Model · Agent selector** in the chat header. Long names are pretty-printed (e.g. `claude-3-5-sonnet-20241022` → `Sonnet 3.5`, `gpt-4o` → `GPT-4o`, `code-reviewer` → `Code Reviewer`). Click to open a small popover that targets either the model or agent QuickPick.
- **Compact icon-only buttons** for `+ New chat` and the History clock (4:00 face) — no labels stealing horizontal space in narrow panels.

### History popover
- **Searchable list** of conversations (search input appears at 5+ chats).
- **Relative time** display: `just now`, `5m ago`, `2h ago`, `yesterday`, weekday, `Mar 5`, `Aug 2024`.
- **Hover-revealed Rename / Delete** controls keep the row uncluttered until you need to act.
- **Two-click delete confirmation** — first click turns the button into `Confirm`, auto-reverts after 3 seconds.
- **Active conversation accent**: 2px left border in `--vscode-focusBorder`, single-line row layout.
- **Per-workspace conversation storage** — each project has its own independent history (auto-migrates from prior global storage on first run).
- **Prominent "New chat" affordance** with a green link-style action.

### Conversation rendering
- **Inline tool trace**: file ops are grouped (one row per file regardless of how many calls touched it), reads collapse to a compact `Read N: foo.ts, bar.ts` line, edits get bordered cards with `+N −N` stats and click-to-review.
- **Inline Todos** — when the AI updates its plan via `todowrite`, the todo block renders in the conversation flow with status-colored circles (yellow in-progress, green check, strikethrough cancelled) and a `N/N` progress count.
- **Code blocks**: syntax highlighting (Shiki), `Copy`, plus a context-aware action button:
  - **Run** for shell snippets (bash/sh/zsh/fish/powershell/etc.) → opens the integrated terminal and executes the command.
  - **Apply** for code → replaces editor content (or selection); `Cmd+Z` to undo.
- **Internal-marker stripping** — `<system-reminder>`, HTML comments (`<!-- ... -->`), and harness scaffolding tags are filtered before display so they never leak into chat content.
- **Markdown rendering** with code blocks, file mentions, and message metadata (model · cost · tokens).

### Review changes card
- **One row per file** with cumulative `+N −N` aggregated across multiple edits in the same conversation (an edit followed by another edit of the same file sums up; row reflects the total work).
- **File-kind colors**: green for created, strikethrough red for deleted, yellow for moved (matches VS Code git decorations). Path disambiguation when basenames collide (`views/index.ts` vs `admin/index.ts`).
- **Inline `Keep` / `Undo` buttons** per row (hover-revealed) — accept or revert all hunks in a file. Underlying revert is performed via opencode's `session.revert`, which rolls back file effects too.
- **Auto-purge for deleted files** — if you remove a file outside the AI's actions, its row vanishes from the panel on the next sync.
- **Single-file collapsed header**: `Review · foo.ts +5 −2` instead of `Review changes · 1 file`.
- **Smooth expand animation** without a transient inner scrollbar; symmetric `scrollbar-gutter: stable both-edges` keeps message bubbles centered.

### Editor integration
- **Apply on bash blocks** routes to the integrated terminal and executes immediately.
- **Apply on code blocks** replaces the active editor's selection (or whole file) — `Cmd+Z` to revert.
- **Open file from chat**: any path mentioned in the AI's tool log is clickable.
- **Edit-in-place review flow** — review actions live in the Review Changes card; the editor stays clean (no codelens or decorations).

### Backend management
- The extension owns and manages a single `opencode serve` subprocess per session. It auto-spawns on activation, exposes the HTTP/SSE endpoint to the SDK, and shuts down cleanly on deactivation or `OpenCUI: Restart Backend`.

## Requirements

- VS Code **1.94+**
- `opencode` binary on `PATH` (or set `opencui.binaryPath` to an absolute path)
- **Bun** for development (not required at runtime)

## Develop

```bash
cd opencui
bun install
bun run compile
```

Then open this folder in VS Code and press `F5` to launch an Extension Development Host.

For local-source development against a sibling opencode checkout, override `opencui.binaryPath` in your **user** settings (not workspace, so it doesn't ship). The repo's `.vscode/settings.json` is git-ignored so each contributor can configure their own dev binary.

## Tests

The project ships with a Vitest-based test suite covering the core diff/path/format/trace logic on both the host and webview sides.

```bash
bun run test           # one-shot run
bun run test:watch     # rerun on file change
bun run test:coverage  # generate coverage report (HTML at coverage/index.html)
```

### What's covered

- **Host (`test/host/`)**:
  - `diff-utils.test.ts` — path utilities, isTextReviewPath, patchKind/patchPath, escapeHtml, findHunkText, splitReviewDiff, diffLines, reviewLineText, firstReviewAnchor, reviewKey, synthesizeCreatePatch.
  - `review-changes.test.ts` — toolChanges write/edit/apply_patch flows, patchChanges, displayPath, reviewChanges dedup rules.
  - `migrate-conversations.test.ts` — workspace-state migration: idempotency flag, copy from global, global cleanup.

- **Webview (`test/webview/`)**:
  - `format.test.ts` — formatModel for Claude/GPT/Gemini families and unknown fallbacks, formatAgent slug-titlecase, formatUpdated across all time bands.
  - `strip-markers.test.ts` — system-reminder stripping, HTML comments, command-tags, blank-line collapse.
  - `disambiguate.test.ts` — same-basename path collision resolution.
  - `turn-changes.test.ts` — synthesizeCreatePatch, patchKind, isTextReviewChange, splitDiff, turnChanges aggregation (sums additions/deletions across multiple edits to the same file, retains earliest "created" kind), countDiff.
  - `build-trace.test.ts` — buildTrace file-op grouping, todowrite routing into trace.todos, classification of grep/glob/bash/webfetch, apply_patch metadata expansion, toolHeadline summaries, mergeStatus / preferAction / pickPath helpers.

### Coverage snapshot (147 tests, 100% pass)

```
File               | % Stmts | % Branch | % Funcs | % Lines
-------------------|---------|----------|---------|---------
All files          |   40.56 |    33.13 |   35.76 |   41.25
src/chat/view.ts   |   77.03 |    62.78 |   74.17 |   77.76
ReviewPanel.tsx    |   55.78 |    50.98 |   42.00 |   59.18
ToolCard.tsx       |   64.03 |    48.70 |   57.89 |   70.51
StatusBar.tsx      |   42.40 |    37.41 |   25.00 |   39.10
```

The pure-logic surface — diff parsing, path utilities, format helpers, trace builder, change aggregation, marker stripping — is well-covered (60–77% on the modules where the logic lives). Uncovered code is mostly React render bodies (App.tsx, MessageView render, CodeBlock, PermissionDialog, PromptBox); those need component tests via React Testing Library — a planned follow-up.

### Test stack

- **Vitest 4** with two project configs (`host` runs in node with a vscode-module mock; `webview` runs in jsdom).
- **@vitest/coverage-v8** for V8-native coverage.
- **@testing-library/react** + **@testing-library/jest-dom** ready for component tests.
- vscode-module mock at `test/host/setup.ts` provides minimal stubs for `Position`, `Range`, `Uri`, `WorkspaceEdit`, `MarkdownString`, `EventEmitter`, plus `workspace`/`window`/`commands` namespaces — enough for pure-helper imports without spinning up VS Code.

## Package

```bash
bun run package
npx @vscode/vsce package
```

Outputs `opencui-x.y.z.vsix`. Install with:

```bash
code --install-extension opencui-x.y.z.vsix
```

## Settings

| Setting | Default | Description |
|---|---|---|
| `opencui.binaryPath` | `opencode` | Path to opencode binary (absolute path or PATH-resolvable name) |
| `opencui.serverPort` | `0` | Port for the opencode server (`0` = auto) |
| `opencui.model` | `""` | Default model id (reserved) |

## Commands

| Command | Default keybinding |
|---|---|
| `OpenCUI: Focus Chat` | `Cmd+L` / `Ctrl+L` |
| `OpenCUI: Inline Edit` | `Cmd+K` / `Ctrl+K` (in editor) |
| `OpenCUI: New Chat` | — |
| `OpenCUI: Select Conversation` | — |
| `OpenCUI: Select Agent` | — |
| `OpenCUI: Select Model` | — |
| `OpenCUI: Restart Backend` | — |
| `OpenCUI: Show Logs` | — |

## Architecture

```
VS Code (this extension)
   │  HTTP / SSE  via @opencode-ai/sdk
   ▼
opencode serve (managed subprocess)
   │
   ▼
Agent / Tools / Providers (opencode + plugins like oh-my-opencode)
```

The extension owns:
- Webview UI (React + Vite, bundled into a single `dist/webview/index.html`)
- Conversation persistence (per-workspace via `context.workspaceState`)
- Editor context collection (active file, selection)
- Code application to the editor / integrated terminal

opencode owns:
- AI agent runtime / tools / model providers / sessions
- Diff generation, hunk metadata, agent definitions, MCP integrations

Plugins like **oh-my-opencode** (a.k.a. `oh-my-openagent`) are loaded by opencode itself — OpenCUI surfaces whatever agents the running opencode server reports via `GET /agent`.
