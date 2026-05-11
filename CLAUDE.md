# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

OpenCode CUI is a VS Code extension that wraps [opencode](https://github.com/sst/opencode) into a React chat sidebar. The extension is **decoupled** from opencode internals at runtime — it only talks to opencode's HTTP/SSE server through `@opencode-ai/sdk`. Never `import` anything from `opencode` directly; everything goes through the SDK client.

## Build, test, dev

```bash
# Build (host esbuild + webview vite single-file)
bun run compile             # one-shot
bun run watch               # esbuild watch + vite single rebuild
bun run package             # production build (minified)

# Tests
bun run test                # Vitest: phases 1 (unit) + 3 (component) + 4 (mock-opencode E2E). ~5s.
bun run test:watch          # vitest watch
bun run test:coverage       # writes coverage/index.html
bun run test:integration    # phase 2 — boots a real VS Code via @vscode/test-electron (~30s first run)

# Single test file
bun run test path/to/file.test.ts
bun run test -t "name pattern"   # filter by test name

# Type-check only (no build)
bun run check-types         # tsc --noEmit (host side)
cd webview && bunx tsc --noEmit   # webview side
```

Three pre-existing type errors live in `webview/src/App.tsx` (`findLast` requires es2023) and `MessageView.tsx` (a `boolean | undefined` arg). They are not caused by your changes — verify by running tsc on `main` if in doubt.

## Architecture

### Two TypeScript trees joined at a shared protocol

- **`src/`** — the VS Code **extension host** (Node). Owns the opencode subprocess, persists conversations to `workspaceState`, handles file I/O.
- **`webview/src/`** — the **React webview** (browser). Runs inside VS Code's webview iframe; no Node APIs.
- **Communication**: a single discriminated-union message protocol in `webview/src/protocol.ts` (re-exported from `src/protocol.ts` for the host). `Outbound = host → webview`, `Inbound = webview → host`. **Whenever you add a new interaction, add a variant to one of those two unions first** — both sides import the same types, and TS will lead you to every site that needs updating.

### Host-side module layout (`src/`)

The chat host was split out of a single 1700-line `view.ts` into focused modules. Each only imports from files lower on this list to keep the dependency graph acyclic:

```
chat/paths.ts            pure string helpers (normalizePath, samePath, escapeHtml, isRecord, …)
chat/diff.ts             diff parsing types/fns (splitReviewDiff, hunkText, reviewKey, findHunkText, …)
chat/review-changes.ts   tool/patch → ReviewChange synthesis
chat/prompt-builder.ts   buildPrompt + readMentions (reads @file content into the prompt)
chat/conversation-store.ts  workspaceState keys + migrate-from-globalState
chat/wire-format.ts      SDK ToolUpdate → wire format (path rewrites)
chat/fs-ops.ts           applyCode, openFile, workspaceFileUri*, reviewHunk
chat/review-render.ts    (mostly dead — old standalone-panel HTML rendering)
chat/stream.ts           opencode SSE subscription + event normalization
chat/view.ts             ChatView class (WebviewViewProvider + message reducer)
```

Outside `chat/`:
- `server.ts` — spawns and monitors `opencode serve`; exposes `Backend = { url, client, directory }`.
- `attachments.ts` — paperclip flow: VS Code file dialog → base64 data URL + `sourcePath`.
- `file-search.ts` — workspace file index for the `@` picker. **Caches** for 30 s; `getRecentlyOpenedPaths()` boosts files currently open in tab groups.
- `picker.ts` — `pickAgent` / `pickModel` QuickPicks. `isUserSelectableAgent` filters out opencode's internal `compaction` / `summary` / `title` agents.
- `inline/edit.ts` — Cmd+K inline edit flow.
- `preferences.ts` — persisted agent/model selection.

### Webview-side (`webview/src/`)

- `App.tsx` — composes the sidebar (StatusBar, messages, ReviewPanel, PromptBox, PermissionDialog). Owns the scroll container.
- `hooks/useChatState.ts` — single `useReducer` for all state. The reducer is **exported** so it can be tested in isolation (`test/webview/abort-flow.test.ts` does this). Adds a request/response pattern (`fileSearch`, `attachFile`) via two `useRef<Map>`s of pending resolvers.
- `mention-tokens.ts` — pure helpers shared between `PromptBox.tsx` (input) and `MessageView.tsx` (rendered bubble): `detectMention`, `extractMentions`, `findMentionRanges`, `findChipAtCaret`, `makeAttachmentLabel`. Both files import from here.
- `components/PromptBox.tsx` — the rich input. Backdrop overlay technique: a transparent `<textarea>` over a positioned `<div>` with the same wrapping and `<span class="mention-chip">` around recognized `@path` tokens, so the textarea keeps native cursor/selection but the chips paint behind it. Accepts `variant: "send" | "edit"` and `initial: { text, mentions, attachments }` so `MessageView`'s in-place edit flow can reuse the whole thing.
- `components/MessageView.tsx` — handles both user and assistant rendering. User bubbles are `position: sticky; top: 0` **wrapped per-turn** (`App.tsx`'s `groupTurns()`) so they hand off as you scroll — not all sticky at once.

### Several flows worth knowing

- **Per-turn sticky bubbles**: `App.tsx` groups flat `state.messages` into turns via `groupTurns()`. Each turn renders inside its own `<div class="turn">`, which is the sticky containing block for the user message inside. Without per-turn wrapping, every user bubble fights to stick at `top: 0` of the shared scroll container.
- **Abort state machine**: when the user presses Stop, the host sets `this.aborting = true` and posts `{type: "aborted"}` BEFORE awaiting `session.abort`. The webview reducer (a) marks ONLY the last pending assistant as `stopped: true`, (b) sets `state.aborting = true`, and (c) drops subsequent `textDelta` / `reasoningDelta` / `tool` / `patch` events. `tool` and `patch` are intentionally NOT dropped (a tool's final state closure is meaningful). The host's `onAssistantEnd` suppresses the redundant `"Aborted"` error post when `this.aborting`. `onSessionIdle` clears both `aborting` flags.
- **Sticky `stopped` vs `error`**: a message can carry both (race or legacy data). `MessageView` renders Stopped if `message.stopped` OR `error` matches `/^aborted$/i`; otherwise the red error block. Old persisted messages with `error: "Aborted"` automatically render as Stopped.
- **`@file` chip rendering**: `findMentionRanges` requires the **trailing** boundary to be whitespace/EOS but NOT the leading boundary. `look@src/foo.ts` is a valid chip; `@foo.ts` inside `@foo.tsx` is not. The picker triggers on ANY `@` (relaxed from "after whitespace" — picker is non-modal so over-triggering is harmless).
- **IME composition**: every Enter handler that fires actions on text input MUST guard `if (e.nativeEvent.isComposing || e.keyCode === 229) return`. Currently in `PromptBox.onKeyDown` and `StatusBar`'s rename input. Without this, Enter to commit a Chinese/Japanese/Korean candidate fires the action instead.

## Testing setup specifics

`vitest.config.ts` aliases `react` / `react-dom` / their jsx-runtimes to the **root** `node_modules`. This is because the webview ships its own React in `webview/node_modules/`, and without the alias `@testing-library/react` (which resolves from the root) and the webview components (which resolve from the webview) end up with two physically distinct React copies, producing `Cannot read properties of null (reading 'useState')`. **Don't remove this alias.**

Tests run in two Vitest projects:
- **`host`** (node env) — uses `test/host/setup.ts` which `vi.mock("vscode", …)`s with a minimal stub (`Position`, `Range`, `Uri`, `WorkspaceEdit`, `EventEmitter`, plus `workspace`/`window`/`commands`/`tabGroups` namespaces). Anywhere in the host code that touches `vscode.window.fs.readFile` etc., extend this mock rather than spinning up real VS Code.
- **`webview`** (jsdom env) — uses `test/webview/setup.ts`, jsdom-based, RTL.

Integration tests (`test/integration/`) compile separately via `test/integration/tsconfig.json` to `dist/test/integration/`, then run under `@vscode/test-electron` via `.vscode-test.mjs`. They DO boot a real VS Code instance — slower, but they exercise the actual extension activation.

For the mock-opencode E2E (`test/host/e2e-mock-opencode.test.ts`), `mock-opencode-server.ts` stands up an HTTP server matching opencode's surface: `/agent`, `/config/providers`, `/session`, `/session/{id}/prompt_async`, `/session/{id}/revert`, `/session/{id}/abort`, `/global/event` SSE stream. Push scripted events through `server.push(event)`.

## Conventions / style

- **No emojis in code or comments** unless the user explicitly asks.
- **Don't add comments that just restate what the code does.** Only comment WHY when non-obvious — hidden invariants, surprising decisions, references to a past bug.
- **No backward-compatibility shims for code I just wrote.** If a signature changes and the old callers are all in this repo, change them all; don't keep a stale alias around.
- **Match existing test patterns**: pure helpers get their own `*.test.ts` next to the host or webview folder; component tests are `*.test.tsx`. Use the existing reducer-export pattern for state machine tests rather than rendering a wrapper.

## What NOT to do

- Don't import `opencode` directly. Only `@opencode-ai/sdk`.
- Don't render `@path` mentions via `contentEditable` — the existing transparent-textarea + backdrop approach is intentional and preserves native selection, undo, and cursor.
- Don't drop the `aborting`-state checks in the reducer when adding new SSE event types — newer event types should fall under the same "ignore while aborting" gate unless they're terminal state closures.
- Don't add CSS animations to `.review-panel` or anything that re-mounts on state changes — they flash visibly when React remounts on prop changes.
