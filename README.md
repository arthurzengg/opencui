# OpenCUI

> A modern React chat sidebar for AI coding in VS Code — powered by
> [opencode](https://github.com/sst/opencode). Bring your own model
> (Anthropic / OpenAI / Gemini / local), keep your conversation, your
> review flow, your files. Everything runs locally; nothing leaves your
> machine except the API call to your chosen LLM provider.

<!-- TODO: screenshots
![Chat panel](media/screenshots/chat.png)
![@file picker](media/screenshots/mention-picker.png)
![Review Changes](media/screenshots/review-changes.png)
-->

## Highlights

- **Workspace-aware chat** with streaming, reasoning blocks, and an inline tool-call trace.
- **`@file` mentions** — fuzzy file picker with chip-styled tokens inline in the textarea, two-step-Backspace deletion, recently-opened files boosted.
- **Image / PDF attachments** — paperclip + drag from Finder; files sent to opencode as `FilePartInput`.
- **Edit + regenerate** — click any past user message to revise; the conversation rewinds via opencode's `session.revert` (file effects rolled back too).
- **Per-file Review Changes card** with `Keep` / `Undo` (per row + `Keep all` / `Undo all`).
- **Inline edit** via `Cmd+K` / `Ctrl+K` — rewrite the selection with natural language.
- **Per-workspace conversation history** with search, rename, and delete.
- **Cmd+L** opens the chat sidebar.

## Prerequisites

OpenCUI talks to a locally-running [opencode](https://opencode.ai) server. You need opencode installed and signed in to a provider **once**:

### Install opencode

| Platform | Command |
|---|---|
| macOS / Linux | `curl -fsSL https://opencode.ai/install \| bash` |
| Windows (PowerShell) | `irm https://opencode.ai/install.ps1 \| iex` |
| Any system (npm) | `npm install -g opencode-ai` |
| macOS (Homebrew) | `brew install sst/tap/opencode` |

### Sign in

```bash
opencode auth login
```

Pick a provider (OpenCode Zen / Anthropic / OpenAI / etc.) and paste your API key. This is a one-time setup — opencode stores the credentials at `~/.local/share/opencode` (Linux/macOS) or `%APPDATA%\opencode\` (Windows).

### Verify

```bash
opencode --version
```

If `opencode` isn't on your PATH after install, set `opencui.binaryPath` in VS Code settings to its absolute path.

## Install OpenCUI

Search for **"OpenCUI"** in the VS Code Extensions sidebar, or install from the command line:

```bash
code --install-extension opencui.opencui
```

Open the OpenCUI sidebar (click the activity-bar icon or press `Cmd+L` / `Ctrl+L`).

## Settings

| Setting | Default | Description |
|---|---|---|
| `opencui.binaryPath` | `opencode` | Path to the opencode binary. Set to an absolute path if it's not on `PATH`. |
| `opencui.serverPort` | `0` | Port for the local opencode HTTP server (`0` = auto-assign). |
| `opencui.model` | `""` | Default model id (`providerID/modelID`). Use the Model selector in the chat header to change without editing settings. |

## Features

### Chat
- **Sidebar chat panel** with workspace context, streaming responses, reasoning blocks, and a tool-call trace inline in the conversation.
- **Sticky user message** — your most recent question pins to the top of the messages area while the AI streams its answer (Claude.ai / ChatGPT-style "section header"). Per-turn wrapping means scrolling up hands off cleanly between turns.
- **Edit + regenerate previous prompts** — click any past user message to revise it; the conversation rewinds via `session.revert` (file effects rolled back too) and the AI re-answers from there. The edit popup is a full PromptBox — same picker, same chips, same paperclip.
- **`@file` mentions** — type `@` in the prompt to open a fuzzy file picker over the workspace, navigate with arrows, Enter/Tab/click to insert. Inserted mentions render as **highlighted chips** inline in the textarea (transparent textarea over a positioned backdrop layer — gives a colored chip without breaking selection, undo, or character-level cursor). **Two-step Backspace** at the right edge of a chip: first press highlights, second press deletes the whole `@path` token. Recently-opened tabs are boosted in the picker. Selected files are read on send and prepended to the prompt (capped at 20 files / 200 KB total).
- **Image / PDF uploads** — paperclip button next to Send opens VS Code's native file dialog filtered to images (`png/jpg/jpeg/gif/webp/bmp/svg`) and `pdf`. Picked files insert as inline `@filename` chips at the cursor, same chip styling and Backspace deletion as `@file` mentions. Same-name files get disambiguated labels (`@screen.png`, `@screen_2.png`). On send the attached files are forwarded to opencode as `FilePartInput` with `file://` URLs and persist as attachment blocks on the user message bubble. Per-file cap 10 MB, total 25 MB.
- **IME-aware Enter** — pressing Enter to commit a Chinese / Japanese / Korean composition does not accidentally send the message.
- **Inline thinking indicator** with a soft "breathing" opacity animation while the AI is producing its first token.
- **Welcome screen** with one-click suggestion prompts.
- **Inline edit** (`Cmd+K` / `Ctrl+K`) — rewrite the selection with a natural-language instruction.

### Status bar
- **Combined Model · Agent selector** in the chat header. Long names are pretty-printed (`claude-3-5-sonnet-20241022` → `Sonnet 3.5`, `gpt-4o` → `GPT-4o`, `code-reviewer` → `Code Reviewer`). Click to open a small popover that targets either the model or agent QuickPick.
- **Internal agents hidden** — opencode's `compaction` / `summary` / `title` helper agents are filtered out of the picker.
- **Compact icon-only buttons** for `+ New chat` and the History clock.

### History popover
- **Searchable list** of conversations (search input appears at 5+ chats).
- **Relative time**: `just now`, `5m ago`, `2h ago`, `yesterday`, weekday, `Mar 5`, `Aug 2024`.
- **Hover-revealed Rename / Delete** controls. Two-click delete confirmation (auto-reverts after 3s).
- **Per-workspace conversation storage** — each project has its own independent history.

### Conversation rendering
- **Inline tool trace**: file ops are grouped (one row per file regardless of how many calls touched it), reads collapse to a compact `Read N: foo.ts, bar.ts` line, edits get bordered cards with `+N −N` stats and click-to-review.
- **Inline Todos** — when the AI updates its plan via `todowrite`, the todo block renders inline with status-colored dots (yellow in-progress, green completed, strikethrough cancelled) and a `N/N` progress count.
- **Code blocks**: syntax highlighting (Shiki), `Copy`, plus a context-aware action button:
  - **Run** for shell snippets (bash / sh / zsh / fish / powershell / etc.) → opens the integrated terminal and executes the command.
  - **Apply** for code → replaces editor content (or selection); `Cmd+Z` to undo.
- **Collapsible `<system-reminder>` callouts** — internal scaffolding tags are rendered as folded `<details>` blocks (with the first line as a preview) instead of leaking into chat content. Other internal markers (`<!-- ... -->`, `command-name` tags) are stripped.
- **`Stopped` badge** — pressing Stop renders a neutral grey "● Stopped" footer note on the last pending message; not a red error block.

### Review changes card
- **One row per file** with cumulative `+N −N` aggregated across multiple edits in the same conversation.
- **File-kind colors**: green for created, strikethrough red for deleted, yellow for moved. Path disambiguation when basenames collide (`views/index.ts` vs `admin/index.ts`).
- **Inline `Keep` / `Undo` buttons** per row (hover-revealed) — accept or revert all hunks in a file. Underlying revert uses opencode's `session.revert`.
- **`Keep all` / `Undo all`** in the panel header for multi-file changes.
- **Auto-purge for deleted files** — if you remove a file outside the AI's actions, its row vanishes from the panel on the next sync.

### Editor integration
- **Open file from chat**: any path mentioned in the AI's tool log is clickable.
- **Edit-in-place review flow** — review actions live in the Review Changes card; the editor stays clean (no codelens or decorations).

### Backend management
- The extension owns and manages a single `opencode serve` subprocess per workspace. It auto-spawns on activation, exposes the HTTP/SSE endpoint to the SDK, and shuts down cleanly on deactivation or `OpenCUI: Restart Backend`.
- The extension is **decoupled** from opencode at runtime: it only talks to opencode's HTTP server through `@opencode-ai/sdk`. opencode internals are never imported.

## Develop

```bash
cd opencui
bun install
bun run compile         # esbuild + vite single-file
bun run watch           # rebuild on change
```

Then open this folder in VS Code and press `F5` to launch an Extension Development Host.

For local-source development against a sibling opencode checkout, override `opencui.binaryPath` in your **user** settings (not workspace, so it doesn't ship). The repo's `.vscode/settings.json` is git-ignored so each contributor can configure their own dev binary.

## Tests

The project ships a comprehensive test suite across four phases:

| Phase | Layer | Stack | Tests |
|---|---|---|---|
| 1 | Unit (pure helpers) | Vitest + node/jsdom | 244 |
| 2 | Integration (VS Code extension host) | @vscode/test-electron + Mocha | 14 |
| 3 | Component (React UI) | Vitest + RTL + jsdom | 103 |
| 4 | E2E (mock opencode HTTP/SSE server) | Vitest + node http | 12 |
| **Total** | | | **373 tests, 100% pass** |

### Commands

```bash
bun run test              # phases 1 + 3 + 4 (Vitest, ~5s)
bun run test:watch        # rerun on file change
bun run test:coverage     # phases 1 + 3 + 4 with coverage report at coverage/index.html
bun run test:integration  # phase 2 (downloads VS Code if needed; ~30s on first run)
```

CI runs all of these on every push and PR (see `.github/workflows/ci.yml`).

### Test stack

- **Vitest 4** with two project configs (`host` runs in node with a vscode-module mock; `webview` runs in jsdom).
- **@vitest/coverage-v8** for V8-native coverage.
- **@testing-library/react** + **@testing-library/user-event** + **@testing-library/jest-dom** for component tests.
- **@vscode/test-electron** + **@vscode/test-cli** + **Mocha** for integration tests against a real downloaded VS Code instance.
- **node:http**-based mock opencode server in `test/host/mock-opencode-server.ts` for E2E SSE/HTTP scenarios.
- vscode-module mock at `test/host/setup.ts` provides minimal stubs — enough for pure-helper imports without spinning up VS Code.
- React 18 pinned at the project root and aliased in `vitest.config.ts` so tests share a single React copy with the webview's components.

## Packaging

```bash
bun run vsix                 # vsce package --no-dependencies → opencui-<version>.vsix
bun run publish:marketplace  # vsce publish --no-dependencies   (requires VSCE_PAT)
```

## License

MIT. See [LICENSE](./LICENSE).
