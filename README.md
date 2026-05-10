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
- **`@file` mentions** — type `@` in the prompt to open a fuzzy file picker over the workspace, navigate with arrows, Enter/Tab/click to insert. Inserted mentions render as **highlighted chips** inline in the textarea (transparent textarea over a positioned backdrop layer with `<span class="mention-chip">` wrappers — gives a colored chip without breaking selection, undo, or character-level cursor). **Two-step Backspace** at the right edge of a chip: first press highlights the chip in a stronger selected color, second press deletes the whole `@path` token plus its trailing space — matches Slack/Discord/Notion behavior. Selected files are read on send and prepended to the prompt as fenced code blocks (capped at 20 files / 200 KB total) so the AI sees them as first-class context.
- **Image / PDF uploads** — paperclip button next to Send opens VS Code's native file dialog filtered to images (`png/jpg/jpeg/gif/webp/bmp/svg`) and `pdf`. Picked files insert as **inline `@filename` chips** in the textarea at the current caret position, in order — the same chip styling and two-step-Backspace deletion as `@file` mentions. Same-name files get disambiguated labels (`@screen.png`, `@screen_2.png`). Spaces in filenames become underscores in the chip label so the `@token` boundary stays intact. On send the attached files are forwarded to opencode as `FilePartInput` with base64 data URLs and persist as attachment blocks on the user message bubble in the conversation history (with read-only thumbnails). Per-file cap 10 MB, total 25 MB.
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

The project ships a comprehensive test suite across four phases:

| Phase | Layer | Stack | Tests |
|---|---|---|---|
| 1 | Unit (pure helpers) | Vitest + node/jsdom | 215 |
| 2 | Integration (VS Code extension host) | @vscode/test-electron + Mocha | 14 |
| 3 | Component (React UI) | Vitest + RTL + jsdom | 99 |
| 4 | E2E (mock opencode HTTP/SSE server) | Vitest + node http | 12 |
| **Total** | | | **328 tests, 100% pass** |

### Commands

```bash
bun run test              # phases 1 + 3 + 4 (Vitest, ~5s)
bun run test:watch        # rerun on file change
bun run test:coverage     # phases 1 + 3 + 4 with coverage report at coverage/index.html
bun run test:integration  # phase 2 (downloads VS Code if needed; ~30s on first run)
```

### What's covered

**Phase 1 — Unit (host helpers)** in `test/host/`:
- `diff-utils.test.ts` — path utilities, isTextReviewPath, patchKind/patchPath, escapeHtml, findHunkText, splitReviewDiff, diffLines, reviewLineText, firstReviewAnchor, reviewKey, synthesizeCreatePatch.
- `review-changes.test.ts` — toolChanges write/edit/apply_patch flows, patchChanges, displayPath, reviewChanges dedup rules.
- `migrate-conversations.test.ts` — workspace-state migration: idempotency flag, copy from global, global cleanup.
- `file-search.test.ts` — rankHits empty/exact/prefix/substring/path tiers, tie-break by length, case-insensitivity.
- `build-prompt.test.ts` — buildPrompt context + mention block ordering, readMentions fence-language inference, dedup, partial failure tolerance, total empty-result handling.

**Phase 1 — Unit (webview helpers)** in `test/webview/`:
- `format.test.ts` — formatModel for Claude/GPT/Gemini families and unknown fallbacks, formatAgent slug-titlecase, formatUpdated across all time bands.
- `strip-markers.test.ts` — system-reminder stripping, HTML comments, command-tags, blank-line collapse.
- `disambiguate.test.ts` — same-basename path collision resolution.
- `turn-changes.test.ts` — synthesizeCreatePatch, patchKind, isTextReviewChange, splitDiff, turnChanges aggregation, countDiff.
- `build-trace.test.ts` — buildTrace file-op grouping, todowrite routing into trace.todos, classification of grep/glob/bash/webfetch, apply_patch metadata expansion, toolHeadline summaries, mergeStatus / preferAction / pickPath helpers.

**Phase 2 — Integration** in `test/integration/`:
- `extension.test.ts` — extension activation, all 8 commands registered, settings defaults (`opencui.binaryPath`, `opencui.serverPort`), webview view registration, workspace fixture state.

**Phase 3 — Component (React)** in `test/webview/`:
- `statusbar.test.tsx` — model + agent labels, connecting/connected/error states, selector popover open/click handlers, history popover (search filtering at 5+ chats, two-click delete confirmation, rename inline editor, conversation open).
- `review-panel.test.tsx` — empty state, single-file collapsed header, multi-file summary, kind colors, path disambiguation, Keep/Undo button click → onReviewAllInChange, row click → onSelectPath/onOpenReviewChange, hidden when all hunks reviewed, panel collapse toggle, created-kind retention with turnChanges aggregation.
- `message-view.test.tsx` — user message rendering, edit-on-bubble-click flow, busy/no-backendID gating, Save & regenerate, Cancel, Escape and Cmd+Enter keyboard shortcuts, editor-context label, thinking indicator, error display, usage stats.
- `codeblock.test.tsx` — Apply vs. Run label by language, sh/shell normalization, post `{ type: "apply", code, language }` on click, clipboard write on Copy + briefly-changed label.
- `promptbox.test.tsx` — empty/disabled Send, Enter sends + clears, Shift+Enter inserts newline, Stop button when busy, contextLabel rendering, whitespace-only no-op. Plus `@file` autocomplete: detectMention, extractMentions, picker open/filter/insert via Enter/Tab/click/ArrowKeys/Escape, mention paths forwarded to onSend.

**Phase 4 — E2E (mock opencode)** in `test/host/`:
- `mock-opencode-server.ts` — minimal HTTP/SSE server stub of opencode (sessions, agents, providers, prompt_async, revert, /global/event SSE stream).
- `e2e-mock-opencode.test.ts` — SDK round-trips (session.create, app.agents, promptAsync record, revert record), then `subscribeSession` streaming: onAssistantStart on first message.updated, session-id filtering, terminal vs. non-terminal finish reasons, onUserMessage dedup, text delta accumulation, tool status transitions, patch part forwarding.

### Coverage snapshot (235 tests across all phases, 100% pass)

```
File              | % Stmts | % Branch | % Funcs | % Lines
------------------|---------|----------|---------|---------
All files         |   57.38 |    49.47 |   58.45 |   59.33
src/chat/view.ts  |   77.03 |    62.78 |   74.17 |   77.76
src/chat/stream.ts|   59.42 |    41.61 |   66.66 |   64.16
ReviewPanel.tsx   |   78.42 |    63.23 |   82.00 |   80.27
StatusBar.tsx     |   92.14 |    85.71 |   93.18 |   94.87
PromptBox.tsx     |   94.44 |    92.85 |  100.00 |  100.00
CodeBlock.tsx     |   83.72 |    79.16 |   68.75 |   94.59
ToolCard.tsx      |   64.03 |    48.70 |   57.89 |   70.51
MessageView.tsx   |   36.02 |    38.46 |   57.14 |   42.43
```

Pure-logic and component surfaces are 60–95% covered. The remaining gaps are in modules like `picker.ts`, `preferences.ts`, `server.ts`, `inline/edit.ts`, and `App.tsx` — these are all VS Code-API-heavy thin wrappers tested indirectly by the integration tests in Phase 2 (which spin up a real VS Code).

### Test stack

- **Vitest 4** with two project configs (`host` runs in node with a vscode-module mock; `webview` runs in jsdom).
- **@vitest/coverage-v8** for V8-native coverage.
- **@testing-library/react** + **@testing-library/user-event** + **@testing-library/jest-dom** for component tests.
- **@vscode/test-electron** + **@vscode/test-cli** + **Mocha** for integration tests against a real downloaded VS Code instance.
- **node:http**-based mock opencode server in `test/host/mock-opencode-server.ts` for E2E SSE/HTTP scenarios.
- vscode-module mock at `test/host/setup.ts` provides minimal stubs for `Position`, `Range`, `Uri`, `WorkspaceEdit`, `MarkdownString`, `EventEmitter`, `createOutputChannel`, plus `workspace`/`window`/`commands` namespaces — enough for pure-helper imports without spinning up VS Code.
- React 18 pinned at the project root and aliased in `vitest.config.ts` so tests share a single React copy with the webview's components (otherwise: "Cannot read properties of null (reading 'useState')" from duplicate React installs).

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
