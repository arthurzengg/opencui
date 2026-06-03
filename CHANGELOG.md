# Changelog

All notable changes to OpenCode Panel are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-06-02

### Added
- File-type icons in the `@` file picker: file rows now lead with a category glyph (code, JSON, Markdown, image, lock, archive, ...) so the list is scannable at a glance (#291).

### Changed
- Icons across the UI - the status bar, the `@` picker, the dialogs, and the image controls - now render from VS Code's built-in **codicon** font, so they follow your active color theme and match the rest of VS Code's chrome, replacing the previous mix of inline SVGs, hand-drawn CSS shapes, and unicode glyphs (#289).
- The Review card is refined: the disclosure caret and the Keep / Undo actions (and the bulk Keep all / Undo all) are now codicons, a single-file review collapses to one clean row with inline actions instead of repeating the filename, and the card's entry animation was removed so it no longer flashes when the turn re-renders (#293).

## [1.3.1] - 2026-06-01

### Fixed
- The chat composer no longer locks up after you Stop a turn and immediately switch conversations - the abort state is cleared on conversation restore instead of stranding the disabled "Stopping..." button until a window reload (#283).
- Custom `/commands` now run at the selected reasoning effort (the model `variant`) instead of the model's default, matching regular prompts (#283).
- A session-level error from opencode is surfaced as a notification and settles the Agents popover, instead of failing silently and leaving the turn looking complete (#283).
- A late assistant message arriving after Stop no longer appends a stray empty bubble (#283).
- A malformed streaming delta can no longer throw and tear down the live SSE subscription mid-turn (#283).
- The status bar always shows the Effort selector (defaulting to "default"), matching Model and Agent, so it is discoverable before one is picked (#283).

## [1.3.0] - 2026-06-01

### Changed
- The bottom composer, the review card, and the permission/question dialogs now stack in a single absolutely-positioned bottom dock above the scroll area; `.messages` reserves the dock's measured height (`--bottom-dock-height`) so nothing hides behind the floating composer, and a dialog that co-occurs with pending changes no longer drops under it (#277).
- The review card is restyled as a floating card - rounded border, input background, drop shadow, entry animation, and a fading connector toward the composer - with normalized head/file row heights, a CSS-drawn disclosure chevron, and right-aligned bulk actions (#277). Its top and bottom padding is symmetric and the header hover shares the file-row hover color, so the head and the list read as one surface (#279).
- `MessageView` is memoized and stream deltas are coalesced per animation frame, cutting layout thrash while a turn streams (#265).
- The work-panel fold is animated and streaming layout shift during a turn is reduced (#267).

### Fixed
- The answer is split from the process/thinking section deterministically instead of by prose heuristics (#269).
- Message text is inset 12px so it lines up with the composer width (#271).
- Code blocks in the work panel scroll horizontally instead of stretching the message column (#273).
- Wide images and long unbroken error tokens are constrained to the message column instead of overflowing it (#275).

## [1.2.0] - 2026-05-31

### Added
- `/provider` command + **OpenCode Panel: Manage AI Providers** picker (mirroring `/mcp`) to connect and disconnect AI providers. **Connect** lists every provider that exposes a login method (`client.provider.auth()`) and runs it — an **API key** (`client.auth.set`) or **OAuth** (`client.provider.oauth.authorize` → browser → `...oauth.callback`), handling both the server-orchestrated **device-code** flow (e.g. GitHub Copilot — the user code from the authorize `instructions` is shown and copied to the clipboard, under a cancellable "waiting" progress so an abandoned flow can't hang) and the **paste-a-code** flow. **Disconnect** lists authenticated providers (`client.provider.list().connected`), marks env-var providers as non-removable, and removes a provider's stored credentials behind a confirm — warning when you disconnect the model you currently have selected. Connect works on released opencode; credential removal uses the `DELETE /auth/{id}` route (currently opencode `dev`) and degrades gracefully with a clear hint (and `opencode auth logout`) on versions that lack it.

Closes #260.

## [1.1.0] - 2026-05-30

### Added
- MCP (Model Context Protocol) server management. A native QuickPick — reachable from the Command Palette (**OpenCode Panel: Manage MCP Servers**) and by typing `/mcp` in the chat composer — lists every configured server with a status icon (connected / disabled / failed / needs auth / needs client registration) and inline error detail, fetched via the SDK's `client.mcp.status`. From it you can **add** a server (a multi-step prompt for a local command or remote URL → `mcp.add`), **connect** / **disconnect** (`mcp.connect` / `mcp.disconnect`), **authenticate** a server that needs OAuth (`mcp.auth.authenticate`, where the local opencode server opens the browser and finalizes the flow itself — no code pasting), **remove** stored OAuth credentials (`mcp.auth.remove`), and copy a failed server's error. Status is re-fetched on open and after every action, since the SDK has no MCP push event. `/mcp` opens the picker without posting a chat turn; `mcp.add` is session-scoped (it is not written to your opencode config).
- `/undo`, `/redo`, `/fork`, and `/new` session slash commands in the `/` picker, matching opencode's own built-in slash set. **`/undo`** reverts the last turn (`session.revert`), drops it from the transcript, and restores its prompt text into the composer so you can edit and resend; **`/redo`** re-applies it (`session.unrevert` / `session.revert`). **`/fork`** duplicates the current session into a new conversation (`session.fork`) — copying the history and switching to it — so you can branch and continue independently. **`/new`** starts a fresh chat. Like the other built-ins these post no chat turn. `/redo` is in-memory (it does not survive a window reload), and any new turn or conversation switch clears it.

Closes #252, #254.

## [1.0.0] - 2026-05-30

### Added
- Slash-command picker in the chat composer. Typing `/` at the start of the input opens a picker (mirroring the `@`-file picker) listing the workspace's opencode commands, filtered as you type. Selecting a command whose template uses `$ARGUMENTS` inserts `/name ` and waits for arguments; an argument-less command runs immediately. Running a custom command calls the SDK's `session.command`, which expands the command template server-side (including opencode's own `!shell` / `@file` substitutions) and streams the assistant turn through the existing SSE subscription — so it renders exactly like a normal prompt, and the chat shows the typed invocation rather than the expanded template. The command list is fetched via `command.list` on connect and on each subscription (re)attach; unknown `/foo` and prose like `/etc/hosts` still send as normal prompts.
- opencode's built-in commands in the same picker, since `command.list` returns only user-defined custom commands. `/compact` (summarize and compact the session), `/init` (analyze the codebase and write `AGENTS.md`), `/share`, and `/unshare` are merged in as synthetic entries and routed host-side to their dedicated session endpoints; `/share` surfaces the share URL through a notification with a Copy Link action. A custom command of the same name shadows the built-in.

Closes #248.

## [0.10.1] - 2026-05-29

### Added
- Context-window usage indicator in the bottom composer. A small ring fills as the active model's context window fills — amber at 85%, red at 95% — and a hover tooltip shows the token count against the model's limit, the percentage, the model id, and the conversation's cumulative cost. Usage is computed host-side from the latest assistant message's token counts (input + output + reasoning + cache read/write) and the model's `limit.context` from the providers config, mirroring opencode's own context accounting. It refreshes after each assistant turn, after a message is removed or reverted, and on connect/select/create, and clears when a new conversation starts; the ring appears only in the primary bottom composer once there is real usage to show. A request-counter guards against a stale async refresh overwriting a newer one.

Closes #242, #244.

## [0.10.0] - 2026-05-28

### Added
- Drill-down folder browser in the `@` picker. Choosing **Files** now shows the project tree one level at a time with a breadcrumb: folders are navigation-only (Enter / Right-arrow / click drills in, Left-arrow / breadcrumb goes back up) and files are the only selectable leaf, which removes the "open vs. select a folder" ambiguity. Typing a query still runs the flat fuzzy search across the repo, and the browser falls back to it when the host can't list directories. A new `listDir` request/response derives each folder's immediate children from the same cached file index the search uses, so the ignore-globs and 30s cache are reused.
- **Past Chats** in the `@` picker are grouped by recency — Today / Yesterday / Previous 7 Days / Previous 30 Days / Older (newest-first, empty groups omitted; day boundaries use local midnight so Today/Yesterday track the calendar). Each row shows a relative "updated" label (just now / 5m ago / yesterday / weekday / date), the category row shows a count of past chats, search matches both the title and the visible updated label, and the currently-active conversation is excluded from the list. Keyboard Up/Down/Enter moves through conversations across group boundaries.

### Changed
- User message bubbles no longer carry a drop shadow or gradient feather — they sit flat against the scrolling transcript. The in-place edit overlay matches, so entering edit mode no longer adds a shadow.
- The three chat input boxes now share the bottom composer's width. The empty-state composer and the message bubbles (and therefore the in-place edit box) line up at the same 12px edge gap; the message list keeps its reserved scrollbar gutter so content does not reflow when the scrollbar appears.

### Fixed
- The symbols collector no longer asks the language server to read non-file editors. When the OpenCode Panel Output view or an untitled buffer was the active editor, its URI was treated as a workspace file, producing a noisy "cannot be read" error — especially under WSL remote, where `Uri.file()` resolved to a `vscode-remote://` URI. `getEditorContext` now ignores editors whose URI scheme is not `file`.

Closes #230, #232, #234, #236, #238.

## [0.9.10] - 2026-05-27

### Changed
- The bottom composer now floats over the scroll area as an absolute-positioned overlay instead of being a fixed flex child. A `ResizeObserver` tracks the composer's rendered height and injects it as a `--bottom-composer-height` CSS custom property so the scroll container's bottom padding stays in sync. The conversation scrolls edge-to-edge underneath the composer, and content is never clipped behind it.
- Entering or exiting in-place edit mode preserves the scroll position. `App.tsx` captures `scrollTop` and the stick-to-bottom flag before toggling `editingMessageID`, then restores both in a `useLayoutEffect` before paint — prevents the transcript from creeping upward when Chromium re-anchors around the edit overlay.
- `PromptBox` now emits explicit `promptbox--send` / `promptbox--bottom` / `promptbox--top` class names so CSS can target each variant independently. The bottom send composer carries its own border and background (previously only the inner `.promptbox-input` was bordered).

Closes #228.

## [0.9.9] - 2026-05-26

### Added
- Two-level `@` mention category menu. Typing `@` with an empty query shows a category picker (Files & Folders, Past Chats); selecting a category drills into the existing file search or the conversation list. Typing `@foo` bypasses categories and jumps straight to file results.
- Past-chat context injection via `@` mention. Selecting a past chat from the `@` picker inserts a `@chat:title` chip instead of switching conversations. On send the host resolves conversation IDs to message history and injects it as prompt context (first message + last 29, 100 KB byte budget).
- Conversations are renamed to opencode's LLM-generated session title once the title agent produces one. The prompt-based title remains as an instant fallback until the server title arrives.

### Changed
- The start-conversation chatbox is now at the top of the panel (the welcome screen with title, subtitle, and suggestion buttons is removed). Placeholder simplified to "@ for file, Enter to send"; attach + send icons moved inside the bordered input area.
- `@` mention popover narrowed to `min(240px, calc(100% - 16px))` and positioned beside the `@` caret instead of stretching full width.
- Status bar icons unified to 11px with centered 22px hover circles.
- Removed `useHeaderPopoverHeight` hook — popovers now overlay sticky user bubbles instead of pushing them down.

Closes #210, #214, #216, #218, #220, #222, #224, #226.

## [0.9.8] - 2026-05-25

### Added
- Each review-card row now shows a single-letter status badge before the file name, mirroring VS Code's SCM gutter convention: `M` Modified (amber), `U` Untracked (green), `D` Deleted (red), `R` Renamed (blue). Only the letter carries the kind tint; the file name stays in the default foreground so long paths remain easy to scan. New `kindLetter()` / `kindLabel()` helpers in `webview/src/components/ReviewPanel.tsx`, a new `kind` grid column in `.review-file`, and per-kind color rules tied to the existing VS Code git-decoration tokens (with chart-blue for renames so they stay distinct from untracked-green).
- CI now publishes to Open VSX alongside the VS Code Marketplace, so VSCodium / Cursor / etc. users get every release. New `Publish to Open VSX` step in `.github/workflows/release.yml` (uses `OVSX_PAT`); marketplace publish step is unchanged.

### Fixed
- Review card no longer mis-renders an existing-file edit as `U` (Untracked) when the model called the `edit` tool with `oldString: ""`. `toolChanges()` in `webview/src/review-extract.ts` previously concluded "creation" from the model's *input* alone, but agents legitimately call edit with empty `oldString` against existing files (e.g. to prepend). The kind assignment now also checks the resulting patch and demotes `isCreate` to `false` when the patch shows any `-` lines — a real deletion is proof the file pre-existed. Two regression tests added to `test/host/review-changes.test.ts` covering both the false-positive (oldString="" with deletions → updated) and the genuine create path (oldString="" with no deletions → created).

Closes #198, #200, #202, #204, #206.

## [0.9.7] - 2026-05-24

### Fixed
- **Undo on multi-tool turns is no longer half-reverted.** `aggregateChanges` collapses per-tool ReviewChange records into one row but keeps only the *last* contributing record's `patch`, so iterating the aggregated patch silently missed every earlier tool call's hunks. The host action layer (`src/chat/review-actions.ts`) now iterates the un-aggregated `extractChanges`, newest-first for Undo (layered same-line edits unwind correctly), and keys UI state on the aggregated row so the panel and snapshot map stay consistent.
- **Keep on a created file resolves correctly when opencode anchors paths above the workspace.** `findExistingWorkspaceFile` now (a) honors an opencode-provided absolute-path hint (`apply_patch`'s `files[].absolutePath` or any of `filename` / `path` / `fullPath` when absolute), (b) falls back to walking ancestor directories of `root` up to the user's home if standard candidates miss, and (c) refuses to follow `..` segments. Symmetric for Keep and Undo so resolution stays consistent.
- **Keep on a pure-deletion hunk now verifies the deletion happened.** `findHunkInFile` returns a zero-width match for `newText === ""`, which let Keep silently succeed regardless of file state. `acceptHunk` now checks the removed block is gone before reporting applied.
- **Better diagnosis on path conflicts.** `reportConflict` / `reportMissing` log the tried candidate paths to the output channel so a recurrence is debuggable from the log alone.

Closes #188.

## [0.9.6] - 2026-05-24

### Fixed
- SSE event routing no longer floods the output channel with `[sse] unhandled type:` lines for routine opencode events the host intentionally doesn't act on. 0.9.5's default branch in `src/chat/stream.ts` `route()` / `routeChildSessionEvent()` was meant to surface *new* SDK event types but was firing for every `sync` (after almost every event), `server.heartbeat` (every ~10s), `session.updated` (every internal state tick), `file.watcher.updated`, `project.updated`, `session.next.{agent,model}.switched`, `session.diff`, and the child-session equivalents (`session.created`, `session.updated`, `message.removed`). Each is now an explicit no-op `case` that silently returns, before the default branch. The default branch continues to log truly unknown event types so a new opencode SDK event still shows up immediately in the output channel.

Closes #184.

## [0.9.5] - 2026-05-23

### Changed
- `classifyTerminal` (`src/agents/task-store.ts`) is now table-driven via a `TERMINAL_CLASSIFIERS` array. The single existing `/^aborted$/i → cancelled` rule preserves behaviour exactly; adding a new terminal classification (timeout, rate-limit, quota-exceeded) is now a one-line append instead of editing the function body.
- `summarizeAgentTasks` in `src/chat/view.ts` consults the newly-exported `ATTENTION_STATUSES` set via a `isAttentionStatus` type predicate instead of three hardcoded `task.status === "..."` equality checks. The `AgentsStatusInfo` wire shape is unchanged.
- SSE `route()` and `routeChildSessionEvent()` in `src/chat/stream.ts` gained `default:` branches that emit `[sse] unhandled type: <name>` through the existing `log` helper. New opencode SSE events surface in the output channel instead of silently dropping.
- `ChatView` shrinks from 1877 to 1583 lines (~16%) via three subsystem extractions:
  - `src/chat/conversation-manager.ts` (new) — workspace-state CRUD + persistence (11 methods + the `conversations` array + `activeConversationID` ownership). ChatView keeps the orchestration methods (`createConversation`/`selectConversation`/`deleteConversation`) because they coordinate session teardown across multiple subsystems; they now delegate data operations to the manager and centralise the teardown work in a single `resetSessionState()` helper.
  - `src/chat/continuation-state.ts` (new) — idle-defer state machine (9 methods + 3 timer/flag fields + the `SIGNAL_TTL`/`DEFER_MS`/`GRACE_MS` constants). Takes a `post` callback + an `activeSubagentCount` callback in its constructor; exposes `markSignal` / `hasGate` / `beginDefer` / `finishPending` / `scheduleIdleEmit` / `collapseToGraceIfSettled` / `reset`. Now testable in isolation without spinning up the whole `ChatView`.
  - `src/chat/subagent-dispatch.ts` (new) — per-turn main-task lifecycle + the SSE tool-event bridge into the `SubagentTracker` (4 methods + `currentMainTaskID` ownership + `summarizePrompt` which moved here from `view.ts` as its only host-side caller; `view.ts` re-exports it for the existing test import).

### Removed
- The dead "legacy single-hunk review" chain: webview `reviewHunk` action, `{type: "reviewHunk", ...}` inbound protocol variant, host case branch + `findReviewHunkByKey`, and the entire `src/chat/review-render.ts` (`reviewChangeHtml` + helpers — the modern Review Card flow uses `reviewAllInChange` instead). `fallbackHtml` inlined into its only caller in `view.ts`.
- The dead `selectConversation` webview→host round-trip. `pickConversation` stays live via the registered `opencui.conversation.select` command.
- Four unused re-exports in `src/chat/review-changes.ts` (`aggregateChanges`, `createPatchChange`, `diffChanges`, `extractChanges`).
- Seven dead CSS rule blocks in `webview/src/styles.css` (`.user-edit-input`/`-actions`, `.msg-hint`, the `.thinking` parent + `-toggle/-caret/-label/-preview/-body` family, the `.review-diff-line.add/.del` selectors, `.agents-row-completed`, the `.conversation-row/-select/-title/-caret` family).
- Unused `vsix` npm script and the orphan `scripts/opencode-dev` shell wrapper.

Closes #176, #178, #180.

## [0.9.4] - 2026-05-22

### Changed
- Live agent activity moved out of the chat status bar and into the assistant message that's actually running the work. New `webview/src/components/AgentActivity.tsx` renders a compact `Agents · N running` pill inline with the active response, with an anchored popover listing Main + Subagents (running breathes green, error red, waiting amber). `StatusBar` drops the `AgentsMenu` block, the `agents` popover ID, and the `agentsStatus` prop — `App.tsx` now resolves the right host message (`agentActivityMessageID` prefers the still-pending assistant turn, falls back to the most recent assistant message) and passes the snapshot to that single `MessageView`. At rest the surface is fully invisible (`total === 0` renders nothing), so the status bar stays for chat-wide settings and per-turn activity stays next to the response.

### Fixed
- Tooling-state directories `.omo/` and `.sisyphus/` no longer appear as untracked in `git status`. Added both to `.gitignore` so an accidental `git add -A` can't sweep them into a commit. No tracked files removed.

Closes #170, #172.

## [0.9.3] - 2026-05-22

### Changed
- Status-bar hover backgrounds consolidated behind three semantic tokens in `:root` (`webview/src/styles.css`): `--hover-bg-pill` (for the selector trigger, Agents pill, and the two icon buttons), `--hover-bg-icon` (toolbar-style hover used by `.history-action` inside the chat-history popover and by the Review panel's bulk/file action buttons), and `--hover-bg-row` (list-row hover used by `.selector-row`, `.history-item`, and other menu rows). Tweaking how a category feels — "soften icon hovers", "make pill hovers more saturated" — is now a one-line change instead of touching 5+ selectors. `.history-new` keeps its green-tinted hover intentionally.
- All four bar-level controls (`.selector-trigger`, `.agents-pill`, `.new-chat-trigger`, `.history-trigger`) now share `--hover-bg-pill` so the bar reads as one family on hover. Previously the two icon buttons used `--vscode-toolbar-hoverBackground` while the two pills used `--vscode-button-secondaryHoverBackground`, which in some themes rendered as visibly different colors. Each component still keeps its natural shape — circles for icon-only buttons, rounded rects for text content.

### Fixed
- `+` (`.new-chat-trigger`) hover background is now a perfect circle even on narrow panels. The button is a direct child of `.statusbar` (unlike `.history-trigger`, which is protected by its `.history-menu` wrapper's `flex: 0 0 auto`), so on narrow widths it compressed below 22px wide while keeping height 22px — turning the `border-radius: 50%` into an ellipse. Added `flex: 0 0 auto` directly on the shared `.history-trigger, .new-chat-trigger` rule so the 22×22 square holds regardless of available space.

Closes #168.

## [0.9.2] - 2026-05-21

### Fixed
- Header popovers (Model/Agent, Agents, Chat history) no longer paint over the sticky user-message bubble. Each popover now publishes its measured height to `--header-popover-height` while open (new hook `webview/src/hooks/useHeaderPopoverHeight.ts`, observed via `ResizeObserver`), and the sticky user bubble (`.msg.role-user`) reads that variable in its `top` so the two stack instead of overlapping. The variable clears on close so the bubble snaps back to `top: 0` without flicker.

### Changed
- Header popovers dismiss on `click` instead of `pointerdown`. Dismissing on pointerdown removed the bubble's CSS-var offset before the browser delivered the bubble's `click`, so a click on the pushed-down bubble landed on whatever was previously underneath it. Routing through `click` lets the bubble see its own activation first, which makes the "click the pushed bubble to close the popover and enter edit mode" gesture work.
- `useDismissableMenu` now supports controlled open state via optional `open` / `onOpenChange` props. `StatusBar` hoists the active-popover identity (`"selector" | "agents" | "history" | null`) up to `App.tsx`, which (a) keeps the three popovers mutually exclusive without each one having to know about the others and (b) lets `MessageView` close whichever popover is open when the user clicks the pushed user bubble to enter edit mode (via new `onBeginEdit` / `onEndEdit` callbacks plumbed App → MessageView).

### Added
- 5 new tests in `test/webview/statusbar.test.tsx` covering the dismissal-timing change (pointerdown leaves the popover open; click closes it), direct popover-to-popover switching, and the click-pushed-bubble → close-popover → enter-edit gesture end-to-end. Total 774 passing (was 769).
- `ResizeObserver` stub in `test/webview/setup.ts` — jsdom doesn't ship one, and the new hook constructs one on mount.

Closes #166.

## [0.9.1] - 2026-05-21

### Changed
- Agents popover normalized to share its layout vocabulary with the other two header popovers (Model/Agent selector, Chat history). Same `top` gap below the statusbar (`calc(100% + 2px)`, was `+ 6px`), same design tokens (`var(--z-popover)` instead of raw `50`, `var(--radius)` instead of `4px`, `--vscode-sideBar-background` fallback instead of `--vscode-editorWidget-background`), and the same `0 8px 24px / .32` drop shadow. Toggling between the three popovers now feels like one family.
- Agents popover default width capped at 300px (was 360px) so chat content stays visible behind it on narrow side panels. Row content still fits comfortably with ellipsis on overflow. The `min(…, calc(100vw - 20px))` clamp still kicks in on narrower panels.
- All three header popovers (`SelectorMenu`, `AgentsMenu`, `ChatHistoryMenu`) share dismiss boilerplate via a new `useDismissableMenu` hook (`webview/src/hooks/useDismissableMenu.ts`). One source for the open state, the outer ref, the outside-click + Escape listeners. Action handlers use the semantic `close()` helper instead of `setOpen(false)`.



### Added
- Subagent file edits flow into the Review card. The host now extends `ChildSessionEvent` (`src/chat/stream.ts`) with `tool` and `patch` variants and listens for `session.created` events whose `parentID` matches the current session — so opencode's built-in `task` tool (which doesn't reliably publish `metadata.sessionId` on the parent's tool call) is covered alongside the omo / `call_omo_agent` flow that already worked. `ChatView.appendSubagentBlock` resolves which parent assistant bubble owns the child session via `AgentTaskStore.getByChildSession(...).messageID` (with a fallback to the most-recent assistant message), then appends the child's tool/patch block to that bubble with a `ReviewChangeActor` of `{ kind: "subagent", sessionID, subagent }`. The Review card now lists subagent-only files just like main-agent ones; aggregation is deterministic across both sides. Subagent attribution lives on the row's `title` tooltip ("Modified by: <slug>") rather than as a visible inline label. Closes #150.
- Attribution in the change data model. `ReviewChange` gained an optional `actors: ReviewChangeActor[]` (where `actor.kind` is `"main"` or `"subagent"`, plus optional `sessionID` and `subagent` slug); `ChatBlock` tool/patch variants gained an optional `actor` so child-emitted blocks survive webview persistence. The shared `aggregateChanges` helper dedupes actors but preserves all of them, so a file edited by main + subagent appears once with both attributions. `ReviewChange.oldPath` is also new, populated by `apply_patch` move entries so Undo can rename the file back.
- Safe Undo with line-anchored hunk location. `src/chat/diff.ts` exports `parseHunkHeader` and an expanded `ReviewDiffHunk` (now carrying `oldStart` / `oldCount` / `newStart` / `newCount` / `leadingContext` / `trailingContext` / `reversible`). The new `findHunkInFile(current, hunk)` tries the hunk header's `+A,B` anchor first (with newline-tolerant variants) and falls back to unique-substring matching only when exactly one match exists in the file — so a diff against one of two identical text blocks no longer collapses to "use `current.indexOf(newText)` and modify the first one." `src/chat/fs-ops.ts#reviewHunk` now takes the full `ReviewChange` + `ReviewDiffHunk` and dispatches by `kind`: `created` → delete the file (via `vscode.workspace.fs.delete`); `deleted` → re-create with `oldText` (via `fs.writeFile`); `moved` → rename to `change.oldPath` and optionally restore prior content; `updated` → reverse the hunk via a workspace edit at the anchored offset. Returns a structured `ReviewHunkOutcome` (`applied` / `no-op` / `conflict` / `missing` / `unsupported`).
- Keep verifies post-change state before accepting. `acceptHunk` checks file existence for created/deleted kinds and locates the expected `newText` at the hunk anchor for updated/moved kinds; if either check fails the row stays pending and a warning surfaces instead of silently dropping out of the panel. `handleReviewAllInChange` now only records a hunk as `accepted` / `rejected` when the underlying action landed, fixing the previous "silent rejection on conflict."
- Bidirectional dispatch ↔ discovery merge in `SubagentTracker`. When the parent's `task` tool dispatch (`handleToolUpdate`) arrives without `metadata.sessionId` AND `session.created` auto-discovery (`registerChildSession`) also fires for the same parent, whichever path arrives second now claims the orphan from the other path via `promoteToChildSessionIdentity` instead of creating a duplicate popover row. The "exactly one orphan" guard keeps parallel fan-outs honest: ambiguous cases stay as separate rows until `metadata.sessionId` eventually disambiguates them. `input.subagent_type` is read as a fallback for the subagent slug when omo-style `metadata.agent` is absent.
- Shared change-extraction module at `webview/src/review-extract.ts`. Both `src/chat/review-changes.ts#reviewChanges` and `webview/src/components/ReviewPanel.tsx#turnChanges` delegate to `extractChanges` + `aggregateChanges` so host actions (Keep/Undo by path) and webview rendering never disagree about what's in the panel. The aggregator collapses multiple records for one path into one row (summing additions/deletions, preferring sticky kinds `created`/`deleted`/`moved` over plain `updated`, deduping actors).
- Multi-root workspace safety. `workspaceFileUri`, `openFileDocument`, `existingWorkspaceFileUri`, `reviewPathExists`, and `workspaceFileUriCandidates` (all in `src/chat/fs-ops.ts`) accept an optional `root` hint. `ChatView` passes `this.servers.currentWorkspace()?.fsPath` from every review path so relative paths anchor to the opencode backend's directory first — when two VS Code workspace folders both contain `src/index.ts`, the right copy gets targeted.
- 63 new tests across `test/host/review-undo.test.ts` (line anchoring + repeated-text disambiguation), `test/host/review-attribution.test.ts` (host/webview consistency + actor merging), `test/host/review-actions.test.ts` (per-kind Keep/Undo with conflict/missing/unsupported outcomes), `test/host/child-session-discovery.test.ts` (session.created auto-routing), `test/host/child-session-tool-routing.test.ts` (terminal child tool/patch events), `test/host/subagent-edit-integration.test.ts` (full SSE→extractor flow simulating the opencode built-in `task` tool sequence), `test/webview/review-attribution-render.test.tsx` (no visible badge; tooltip-only), plus 9 more in `test/host/subagent-tracker.test.ts` covering the merge logic and the `input.subagent_type` fallback. Total 769 passing (up from 706 on `main`).

### Changed
- Review card row no longer shows an in-row "subagent" label. The previous chip under the filename has been removed — attribution surfaces on the row's hover tooltip as `<path>\nModified by: <subagents>` so the visible chrome stays a single-line filename + stats.
- Review card selected-row highlight switched from `--vscode-list-activeSelectionBackground` (saturated blue) to `--vscode-list-inactiveSelectionBackground` with `--vscode-list-inactiveSelectionForeground` (neutral grey on dark themes, charcoal on light). The vertical accent stripe also moved to `--vscode-foreground` at `0.5` opacity for a subdued look that doesn't compete with the row text.
- Prompt input no longer renders the `@<active-file>` chip above the textarea. The `contextLabel` prop on `PromptBox` and the `.context-chip` CSS rule have been removed; the host still sends `context` events on the wire (other features can consume them later) — only the visible chip is gone.

### Fixed
- Undo on a file containing two identical text blocks no longer mangles the wrong occurrence. The hunk's `+A,B` line numbers from the unified-diff header are now the primary anchor; substring search is only used as a fallback and only when the candidate appears exactly once in the file. Without this, `current.indexOf(newText)` always returned the FIRST match.
- Subagent edits no longer go missing from the Review card. The root cause was that opencode's built-in `task` tool doesn't publish `metadata.sessionId` early enough on the parent's tool call, so the existing metadata-based subagent registration path never fired and the child's tool/patch events were dropped by `subscribeSession`. The new `session.created` auto-discovery path closes that gap.
- Agents popover no longer shows two rows for the same subagent. When `session.created` discovery created a placeholder row keyed by child sessionID AND the parent's `task` tool dispatch created a callID-keyed row, both stayed alive for the duration of the subagent run. Bidirectional merge logic in `SubagentTracker` (`findOrphanDispatch` + `findOrphanChildSessionID` + `promoteToChildSessionIdentity`) collapses them into one row whichever path arrives second.
- `reviewAllInChange` no longer silently marks unsuccessful undo hunks as `rejected`. Conflicts (file diverged), missing (file gone), and unsupported (non-reversible patch) outcomes surface a `showWarningMessage` and leave the hunk pending; only `applied` / `no-op` outcomes record the hunk as reviewed.
- Multi-root workspaces with the same relative path in two folders now resolve review actions to the file in opencode's backend directory rather than whichever folder is iterated first by `workspaceFileUriCandidates`.

## [0.8.0] - 2026-05-19

### Added
- Workspace-grounded prompts. The opencode subprocess is now spawned with `cwd` set to the resolved workspace root (preferring the folder containing the active editor, falling back to the first workspace folder), and every prompt is prefixed with an explicit `Workspace:` block (name + absolute root + a one-liner clarifying that paths below are workspace-relative). A new `src/workspace-root.ts` module centralises root resolution behind `getWorkspaceRoots` / `primaryWorkspaceRoot` / `workspaceRootForUri` / `workspaceRootForPath` / `isInsideRoot` / `isInsideWorkspace` / `relativeToRoot` so file-search, mentions, git, and the (Phase 3) auto-collectors all agree on what "inside the workspace" means — instead of each surface picking its own ad-hoc check against `workspace.workspaceFolders[0]`. Multi-root workspaces resolve to the longest-matching root (so a nested folder beats its parent when the active file lives inside the child), and no-workspace mode is honoured as a first-class state (the host runs with no automatic context and the prompt skips the `Workspace:` block instead of synthesising a fake one from `process.cwd()`). Closes #118.
- Automatic workspace context. When `opencui.context.enabled` is true (default), every prompt picks up a deterministic batch of high-signal collectors that run in parallel via `Promise.allSettled` (so a single collector throwing — e.g. git not installed, language server slow — doesn't take the rest down) under `src/workspace-context/`: open tabs (active editor first, then tab-group order; metadata only, no file contents), VS Code diagnostics (errors first, warnings second, capped at 30, with severity / source / `[code]` / message and `path:line` for every entry), `git status --short` plus unstaged and staged `git diff --unified=3` runs (each diff capped at 60 KB; tolerates non-git directories and a missing `git` binary), an in-memory recent-edits MRU subscribed to `onDidChangeTextDocument` / `onDidSaveTextDocument` / `onDidCreateFiles` / `onDidRenameFiles` / `onDidDeleteFiles` (so the model knows which workspace files the user just touched even before they get mentioned), short summaries of `README.md` / `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` at the workspace root (truncated to ~1.2 KB each), and document-symbol outlines via `vscode.executeDocumentSymbolProvider` for the active file plus any `@`-mentioned files (symbol names + line ranges only, never bodies — bodies stay the agent's job to pull via tools). Every collector is workspace-bound: `isInsideRoot` is the unified predicate, so the auto-pass never reads outside the user's open folders. Collector output is sorted by priority and spliced into the prompt under `## <Title>` headings between the editor-context line and the user request. Closes #121.
- Prompt budget manager. A new `applyAutoContextBudget(blocks, items, { maxAutoBytes })` in `src/workspace-context/budget.ts` drops the lowest-priority collector blocks first when the auto-context total exceeds the cap; blocks are never sliced (preserving diff and symbol-table structure beats squeezing a few extra bytes) and dropped items flip to status `skipped` in the host-side manifest with an explicit "Skipped: over per-prompt auto-context budget (N bytes)" reason. The pre-existing 200 KB mention cap is now configurable. New settings: `opencui.context.maxBytes` (300 KB total context approximation), `opencui.context.maxAutoBytes` (120 KB collector cap), `opencui.context.maxMentionBytes` (200 KB), `opencui.context.showManifest` (kept as a stable setting key even though Phase 2's visible pill was withdrawn before release — see below). Closes #122.
- `opencui.opencodeConfigMode` setting. `isolated` (default) keeps the historical `OPENCODE_CONFIG_CONTENT={}` sandbox so the extension's behaviour stays predictable regardless of the user's local opencode setup; `user` drops the override and lets the spawned opencode subprocess load `~/.config/opencode`, registered agents, and installed plugins (including any OMO / oh-my-openagent installs the user maintains outside the panel). The active mode is recorded on every host-side manifest so logs make it obvious which mode produced a given run, and the wider extension never assumes plugins are loaded — config-mode mismatch is treated as a normal runtime state rather than an error. Closes #118.
- Opt-in semantic-index scaffold. `opencui.indexing.semantic.enabled` ships disabled by default; flipping it on plus configuring `opencui.indexing.semantic.provider` (`none` / `openai` / `local` / `opencode-plugin` — only `none` ships a real implementation today) walks the workspace via `vscode.workspace.findFiles` filtered through a gitignore-style `IgnoreMatcher` (curated defaults exclude `node_modules` / `dist` / `build` / `out` / `coverage` / `.next` / `.turbo` / `.cache`, lockfiles, minified bundles, `.env` / `*.pem` / `*.key` / `*.crt` and friends; supports negation patterns and the `**` / `*` glob shortcuts), reads each file (size-capped at `opencui.indexing.maxFileBytes`, defaulting to 500 KB), runs it through a line-window chunker (60-line window, 40-line step, sha1-hashed for change detection), upserts the chunks into an in-memory `MemoryVectorStore`, and exposes hybrid `path-match + symbol-match + text-match` search via `hybridSearch`. A small status pill (`Index · Disabled / Scanning / Ready / Error` with chunk count + Scan/Stop/Retry buttons) renders above the prompt when the setting is on. The `EmbeddingProvider` / `VectorStore` interfaces are deliberately stable so a follow-up PR can drop in a real OpenAI / local-model / opencode-plugin embedder without changing any call sites — `none` declines via a typed `SemanticIndexingDisabledError` and `hybridSearch` transparently falls back to text-only when the provider can't embed. Persistent storage (SQLite / WASM), file watchers + incremental indexing, symbol-aware chunking, and integration of semantic hits into the prompt itself are all flagged as out-of-scope follow-ups. Closes #124.

### Fixed
- `collectGitDiff` now scopes `git status --short` and `git diff --unified=3` with an explicit `--` pathspec for the workspace folder, so opening a child directory of a larger git repository no longer pulls sibling-project diffs into prompt context as `../...`-prefixed paths. Lowers the per-diff cap and adds a regression test for the parent-repo / sibling-changes case. Closes #130.

### Changed
- Internal: best-effort tool-family classifier (`src/opencode/tool-discovery.ts`) maps opencode tool names into one of `opencode | shell | lsp | omo | semantic | external`. Covers the stock shell tools, the LSP-family tools, the well-known OMO plugins (scout / crafter / lens / hephaestus, todo-continuation, background-task), and the common semantic-search names (`codebase_search`, `semantic_search`, `vector_search`). Unknown tools fall back to the generic `opencode` bucket — surfacing the wrong family is worse than tagging unknowns conservatively. Used by the host-side manifest to populate `opencode.toolFamilies` based on the active config mode (`isolated` = built-ins only, `user` = built-ins + omo + semantic). Closes #123.
- Internal: Phase 2's visible per-prompt context-manifest pill was withdrawn before release. The host-side manifest builder, the `userMessageContext` outbound event, and the `ChatMessage.context` field stay in place (still useful for logs and as a future debug surface), so re-introducing a visible pill is a one-screen JSX add rather than a rebuild. `opencui.context.showManifest` is retained as a settings-schema-stable key so future re-introduction doesn't break user configs. Closes #132.

## [0.7.0] - 2026-05-18

### Fixed
- Reasoning blocks emitted by thinking-enabled models (Claude Opus 4.7 with extended thinking, GPT-5.5, Gemini 2.5 Pro) now render their markdown correctly. Previously, the `ProcessText` component that backs both the reasoning trace and the in-panel text scaffolding wrapped body content in a plain `<div>`, which leaked `## Headings`, `- bullet items`, ` ``` fenced code blocks ` and `` `inline code` `` as literal glyphs — even when the markdown engine for assistant messages elsewhere on the page was rendering identical strings as proper DOM. The body now flows through the existing `<Markdown>` component (same `remark-gfm` + `remark-breaks` + `remark-math` + `rehype-katex` + Shiki pipeline as final answers), so reasoning streams that arrive as structured markdown look structurally identical to their final-answer counterparts. The title-extraction heuristic at `textTitle()` is unchanged: a short single-line first sentence (≤8 words, not pronouns, not raw HTML tags) is still pulled out and rendered as the bold `.process-text-title` chip; only the *rest* — the part the heuristic stripped away — now passes through the markdown pipeline. Two new tests cover both code paths (titled-and-stripped vs. long-first-line-with-mid-block-`##`). CSS-side, `white-space: pre-wrap` is neutralised inside nested `.md` so block elements (which already supply their own line breaks via `remarkBreaks` `<br>` insertion) don't get double-spaced around `<p>` / `<ul>` boundaries. Surfaces every other markdown affordance the chat already supports — GFM tables, task lists, inline + block LaTeX, fenced code with syntax highlighting, links, strikethrough — uniformly inside reasoning traces too. Closes #105.

## [0.6.6] - 2026-05-18

### Changed
- Internal: hoisted the bubble's border width into a shared CSS token (`--bubble-border-width: 1px`) so the placeholder bubble and the absolute edit overlay stay structurally coupled instead of agreeing only through hand-matched literals. The 0.6.5 fix that pulled `.user-edit-layer` outward by `-1px` on top/left/right correctly aligned the overlay's border with the placeholder's, but the relationship between the two was encoded in two unrelated declarations (`.msg.role-user { border: 1px }` and `.user-edit-layer { top/left/right: -1px; border: 1px }`) — bumping the placeholder's border to 2px would have silently broken alignment again. Three rules now reference `var(--bubble-border-width)`: the resting `.msg.role-user` border, the edit-mode placeholder border (re-asserted to prevent the close-time color flash), and the overlay's `top/left/right` offsets + its own border-width. Identical pattern to how `--bubble-padding` / `--bubble-text-padding` already couple `.user-text` and the edit-mode textarea. Zero visual or behavioural change at the current `1px` value — the alignment invariant is now enforced by structure instead of by code review. Closes #101.

## [0.6.5] - 2026-05-18

### Fixed
- Entering edit mode on a user-message bubble no longer shifts the textarea glyphs 1px down + inset from where the rendered `.user-text` painted in view mode. With `box-sizing: border-box` set globally, the placeholder bubble's `border: 1px` lives inside its outer rect, and `position: absolute; top/left/right: 0` on `.user-edit-layer` resolves relative to the placeholder's *padding box* (per the CSS spec) — not its border box — so the overlay's own border landed 1px inside the placeholder's edge, and the textarea inside cascaded that offset. Pulling the overlay outward by `-1px` on top, left, and right makes the overlay's border overlap the placeholder's border pixel-for-pixel; glyph positions are now identical across view and edit. Bottom intentionally stays `auto` — the overlay still grows downward when its action row makes it taller than the placeholder, which is correct (the placeholder freeze keeps following content anchored regardless). Closes #97.

## [0.6.4] - 2026-05-18

### Changed
- Docs: trimmed the README from 176 lines to 69 by dropping the maintainer-focused sections (Tests, Packaging, Backend management, six per-feature subsections) and folding the remaining user-facing prose into an 8-bullet Highlights list. Adds four screenshots (welcome panel, Model · Agent · Effort picker, per-workspace chat history, edit-and-regenerate flow) in a compact 2×2 grid above the fold. Each image is width-constrained via an HTML `<table>` + `<img width="340">` so the two tall portrait shots don't dominate. The VS Code Marketplace listing renders relative-path PNGs and inline HTML natively, so the new listing has an actual visual hook for first-time browsers instead of just text. Closes #71, #93.

## [0.6.3] - 2026-05-17

### Changed
- Internal: simplified the EditPhase state machine from three values (`view | editing | closing`) to two (`view | editing`). The `closing` phase existed only to host a 180 ms border-out CSS fade between editing and view; the visual payoff didn't justify the machinery. Removed: the `useEffect` attaching an `animationend` listener on the overlay, the `CLOSING_ANIMATION` constant coupling JS to a CSS keyframes name, the `@keyframes user-edit-border-out` rule + its `[data-edit-phase="closing"]` selector, and the test-side `endClosingAnimation` helper that constructed a synthetic `AnimationEvent` with `animationName` set via `Object.defineProperty` to work around jsdom's constructor limitation. Every structural benefit of the state machine is preserved — single source of truth, scoped hover/focus rules, attribute-driven CSS, placeholder freeze. `exitEditing` now sets phase to `view` and clears the placeholder height in the same call; the overlay unmounts immediately. If a surface ever genuinely needs an exit animation, re-introduce a 3-phase variant locally there. Closes #89.

## [0.6.2] - 2026-05-17

### Fixed
- Editing a sent user-message bubble in the middle or bottom of the conversation no longer pushes the surrounding dialogue down. The editing UI now renders inside an absolute-positioned `.user-edit-layer` overlay; the bubble's flow box is locked to its collapsed height via a `--edit-placeholder-height` CSS variable captured on edit-entry. The overlay can grow without affecting flow, so assistant text below the editing bubble stays anchored regardless of how much the editor expands. `usePromptText`'s textarea auto-resize moved from `useEffect` to `useLayoutEffect` so the textarea reaches its content-fit height before paint, eliminating a one-frame lag where the bubble had grown but the placeholder hadn't yet.

### Changed
- Internal: replaced the bubble's three-boolean edit lifecycle (`editing` + `editClosing` + `editPlaceholderHeight`) and a `setTimeout(180)` with a single discriminated union `type EditPhase = "view" | "editing" | "closing"`. The row carries `data-edit-phase={editPhase}` as the sole state attribute; CSS keys on `[data-edit-phase="…"]` and `:not([data-edit-phase="view"])` (which scopes editing+closing rules together). Hover and `:focus-visible` rules are scoped to `[data-edit-phase="view"]` so they physically cannot fire during editing or closing — preventing the class of bug where a hover repainted the border underneath the closing-animation overlay. The `setTimeout` is gone; a native `addEventListener("animationend", …)` on the overlay ref (filtered to the `user-edit-border-out` animation name) advances `closing → view`. CSS animation duration is the sole source of truth — the JS reads it via the event, not a magic number, so bumping the duration on one side can't silently desynchronise from the other. Becomes the canonical pattern in the codebase for any future mode-switching surface. Closes #85.

## [0.6.1] - 2026-05-17

### Fixed
- Status-bar dot (`connecting…` / `continuing…` / error states) was visually drifting below the adjacent text glyph because the dot and label were sibling flex children of `.statusbar`, each centred by its own box centre. Extracted a dedicated `<StatusIndicator>` component that gives the dot + label a shared inline line-box with `vertical-align: middle`, aligning by font x-height (the perceived text middle) instead of by box centre. The alignment relationship now lives inside the component rather than as a hidden contract in the bar's JSX, so future edits to `StatusBar` can't re-introduce the drift. Generalises to any future surface that needs a small marker next to text (assistant status, permission badge, tool-trace bullet) — drop in `<StatusIndicator kind="…" label="…" />` instead of redoing the alignment workaround. Closes #81.

## [0.6.0] - 2026-05-17

### Changed
- Internal: introduced a design-token layer so the webview's colors, spacing, icon sizes, radii, and z-index tiers have one source of truth instead of being spread as inline literals. CSS tokens live at the top of `styles.css` (`--space-1` … `--space-6`, `--radius-*`, `--z-*`, `--color-fg`, `--color-bg-input`, `--color-border-focus`, `--color-status-*`, `--bubble-padding`, `--bubble-text-padding`, …); TS constants live in `webview/src/design-tokens.ts` (`ICON_SIZE.{xs,sm,md,lg}`, `Z.*`) for SVG attributes and any inline-style consumers — a typo like `width={11}` is now a compile error. Substituted call-sites in this pass: 6 SVG icons, 7 z-index literals, 5 status dot colors, 6 scrollbar-thumb fallbacks, the coupled bubble-padding chain across five rules (`.msg.role-user`, `.user-text`, `.msg-ref`, `.msg-attachments`, edit-mode textarea + thumbnail strip), and the edit-mode bubble's chrome. The five-rule coupling used to be held together only by code comments cross-referencing each other; "make the padding tighter" is now a one-line change. Pure refactor — zero visual or behavioural change. Closes #77.

## [0.5.3] - 2026-05-17

### Fixed
- Editing a sent user-message bubble no longer shoves the assistant reply (and everything below it) down the page. `UserMessageView` measures the bubble's collapsed height on edit-entry, observes the editing height with `ResizeObserver`, and exposes the delta as a `--edit-overlap` CSS variable that the bubble subtracts from its own `margin-bottom`. Combined with a raised `z-index`, the editor visually overlaps the subsequent content while it's expanded, so the surrounding dialogue stays anchored in place. Exiting edit mode restores the original layout without a snap. Closes #73.

### Changed
- Edit-mode prompt uses a compact one-row textarea (`rows={1}`) as its starting height so the initial editor matches the collapsed bubble; the bottom send composer keeps its two-row default.
- User-message bubble padding is now uniform 4 px on all sides (was 8 × 10 outer + 6 × 8 inner), so the text-to-border distance is consistent vertically and horizontally and the edit-mode height delta is smaller to begin with. Sibling rules (`.msg-ref`, `.msg-attachments`, `.promptbox-thumbs`, the edit-mode textarea) move in lockstep to keep glyphs aligned across display and edit modes.
- Bottom prompt's focus border switches from `--vscode-focusBorder` (hard blue) to `--vscode-foreground` (theme-adaptive, matches the text color) so the active-state cue reads as a calm divider rather than a screaming accent.

## [0.5.2] - 2026-05-17

### Changed
- Internal: decomposed `PromptBox.tsx` into three focused hooks — `usePromptText` (text state + caret + auto-resize), `useImageAttachments` (thumbnail strip + lightbox preview + initial seeding from `initial.attachments`), and `useMentionPicker` (`@`-mention detection + search debouncing + insertion). PromptBox itself drops ~90 lines and each hook is now testable in isolation. No user-visible change.
- Internal: extracted the image thumbnail markup + styling into a shared `<ImageThumbnail>` component used by both the prompt-box strip and the sent-bubble attachment list. Previously the two contexts duplicated ~40 lines of JSX + CSS (`.promptbox-thumb*` and `.attachment-image*`) for what was already pixel-identical output. CSS class names unified to `.image-thumb` / `.image-thumb-open` / `.image-thumb-remove`; the old context-specific names are gone. No user-visible change.

## [0.5.1] - 2026-05-17

### Fixed
- Paperclip-uploaded image files now render as thumbnail tiles in the prompt strip too, matching the behavior added for clipboard paste in v0.5.0. Previously only pasted images got the thumbnail treatment — paperclip images went through the `@filename.png` text-token chip flow, which looked inconsistent and read awkwardly when the same file picker also returned PDFs / code files. Now `handleAttachClick` splits the picker result by mime: image-mime attachments push to the thumbnail strip, non-image attachments (PDFs / `.txt` / code) keep the existing chip-text-token flow because their filenames carry user-meaningful signal. The strip state was renamed `pastedAttachments` → `imageAttachments` to reflect that it now represents any image regardless of source. Closes #60.

## [0.5.0] - 2026-05-16

### Added
- Image paste from the clipboard. `Cmd+V` / `Ctrl+V` of a screenshot or any clipboard image (PNG / JPEG / GIF / WEBP / BMP / SVG) now attaches it directly to the prompt — no paperclip → file-dialog → save-to-disk round-trip. Pasted images render as a small thumbnail strip *above* the textarea (with a hover-X to remove and the filename + size in the tooltip), not as `@filename` text tokens — paste names like `pasted-image.png` carry no signal, so the screenshot itself is the affordance. Implemented entirely in the webview (the bytes are already in `clipboardData.items`, no host hop needed); pasted attachments fall through the existing send path that uses their inline data URL, so opencode receives them exactly like paperclip attachments. Pure-text paste keeps the default browser behaviour; mixed text + image pastes split — text goes to the textarea at the caret, image to the thumbnail strip. Send is enabled with only a thumbnail (no typed text required). Individual images cap at 10 MB to match `MAX_ATTACHMENT_BYTES` on the host. Closes #56.

### Changed
- Image attachments in sent user-message bubbles now render as bare thumbnails (28 × 28, rounded, with a checkerboard background for transparent PNGs), not as a chip pill with `pasted-image.png` text next to a 16-px icon. The screenshot itself is the affordance, the filename + size live in the hover tooltip — matching the prompt-box paste strip so the "before send" and "after send" views are visually consistent. Non-image attachments (PDFs / `.txt` / code files from the paperclip flow) keep the existing chip-pill tile because their filenames carry user-meaningful signal.
- Clicking any image thumbnail (in the prompt-box paste strip or in a sent user bubble) now opens a fullscreen lightbox preview. Dismiss with Esc, the X button, or by clicking the dim backdrop; clicking the image itself keeps it open. The X-remove button on prompt-box thumbnails is a sibling button (not nested in the open button), so it does its own thing without bubbling up to open the preview. Clicking a bubble's thumbnail also doesn't flip the bubble into edit mode (`stopPropagation` on the open button).

## [0.4.0] - 2026-05-15

### Added
- Model picker now surfaces effort / thinking-budget variants. opencode's `/config/providers` response carries a `variants` field on most modern models (e.g. `openai/gpt-5.5` has `none/minimal/low/medium/high/xhigh`, `anthropic/claude-opus-4-7` has `low/medium/high/xhigh/max`, `anthropic/claude-haiku-4-5` has token-budget-based `high/max`) — the previous picker enumerated only model IDs and dropped this entirely, so users couldn't tune reasoning effort without editing `opencode.json`. Model selection stays one-click: the picker lists one row per `(provider, model)` with just the provider name as the description — no variant chatter, since effort is configured exclusively via the StatusBar's Effort row. Changing the model always resets the active variant — variants are model-scoped, so carrying `max` from Sonnet 4.6 over to Haiku 4.5 (which only supports `high`/`max`) would silently produce an invalid combo. The variant is sent on the prompt body as a sibling of `modelID` — matching opencode's wire protocol (`packages/opencode/src/session/prompt.ts:2070,2102`). The bundled `@opencode-ai/sdk` TS types don't yet expose the `variant` field; the HTTP server accepts it regardless, so the prompt body is cast at the dispatch site. Closes #46.
- StatusBar dropdown now has a third **Effort** row (between Model and Agent) that opens a focused variant-only picker for the *current* model — the only place effort is configured. The active variant also renders as plain faded text between the model and agent in the StatusBar trigger — same word style as the agent name, with `·` separators — so the trigger reads `GPT-5.5 · high · Hephaestus deep agent` and the current setting is visible at a glance without a badge-style chip. If the current model has no variants, the Effort row shows `default` and clicking it surfaces an info message rather than opening an empty picker. Backed by a new `opencui.selectVariant` command and `Picker.pickVariantForCurrent()` method that loads providers, finds the active model's variants, and shows a QuickPick with a `(default)` row plus one row per variant; the currently-active selection is checkmarked, and Esc aborts without changing anything.

### Fixed
- Assistant messages now render proper math, tables, lists, headings, and blockquotes. The previous hand-rolled 49-line markdown parser handled only fenced code blocks, bold, italic, inline code, and links, so reasoning-model responses showed raw LaTeX like `\[ n^3 \equiv 14 \pmod{31} \]` instead of formatted equations, and any structured content (numbered steps, comparison tables, headings) collapsed into a wall of text. The webview now pipes assistant text through `react-markdown` with `remark-gfm` (tables / strikethrough / task lists), `remark-math` + `rehype-katex` (math), `remark-breaks` (single newlines render as hard breaks so step-by-step prose doesn't collapse onto one line), and a small pre-pass that normalizes the LaTeX `\(…\)` / `\[…\]` delimiters reasoning models emit into the dollar-form `remark-math` recognises. The pre-pass also escapes `$`-followed-by-digit sequences so prose containing currency like "the plan costs $5 and the upgrade is $10" doesn't parse as accidental math. `rehype-katex` is configured with `{ strict: 'ignore', throwOnError: false }` so half-finished LaTeX arriving mid-stream renders as faint inline text instead of throwing and killing the whole message render. Code fences keep flowing through the existing `CodeBlock` (Shiki highlight + Copy/Apply buttons preserved). KaTeX's fonts are inlined into the single-file webview bundle by the existing `assetsInlineLimit` config, so no font-loading regressions. Closes #48 and #50.
- Prompt textarea and rendered user-message bubble now share a single 160 px max-height ceiling via the `--message-max-height` CSS variable (mirrored as `TEXTAREA_MAX_HEIGHT` in `PromptBox.tsx`), with internal scroll past that. Long pasted prompts no longer blow the sticky-pinned user bubble up to fill the chat area and hide the assistant's reply. Click-to-edit is now glyph-for-glyph aligned: `.user-text` carries the same `6 × 8` padding as the textarea, the inner `.promptbox-input` border + background are suppressed in edit mode (the outer bubble is the input frame), and base padding is no longer overridden in `.is-editing` — so clicking to edit only swaps the rendered text for a textarea and animates a 160 ms fade-in of the action row, with no glyph jump or geometry shift. `overscroll-behavior: contain` on both elements keeps wheel events from chaining to `.messages` once the textarea or bubble hits its scroll boundary. Closes #51 and #53.

## [0.3.9]

### Fixed
- Chat no longer appears to end mid-turn when sub-agents are running or a continuation hook is imminent. Detection is now structural rather than text-based: every `task` tool part on the parent session is tracked through its `running` → `completed`/`error` transitions, and `session.idle` is deferred for as long as any task part is still running. When the last running task settles, a 10-second grace window waits for a continuation toast or new turn before clearing busy. A toast-only path (no active tasks) extends the cap to 120 seconds — Hephaestus-style deep agents can stretch the gap between parent idle and the plugin injecting the continuation, and the previous 30-second cap fired too eagerly. The continuation-toast regex now also covers opencode's auto-resume vocabulary (`Background task complete` / `Background task failed` / `Resuming the main thread`) and omo's `New Background Task`, in addition to the existing `continuation` / `resuming in` patterns. The deferral cancels on `sessionBusy` / `assistantStart` (continuation took over) and on user-initiated abort; if neither signal is present at idle, busy clears immediately as before. While deferred, the status bar shows "Continuing…" instead of "Working…". Background motivation: omo's TodoContinuationEnforcer *suppresses* its own continuation toast when BackgroundManager is handling the wakeup, so toast-based detection alone misses the deep-agent path (`src/hooks/todo-continuation-enforcer/continuation-injection.ts:82-89`); the structural signal closes that gap.

## [0.3.8]

### Fixed
- Auto-scroll no longer fights the user during streaming. The chat container's `onScroll` handler used to re-engage stick-to-bottom whenever the view was within 80 px of the bottom — but each `textDelta` re-scrolled to the bottom, so a small upward gesture stayed inside the threshold and the next delta yanked the view back down. Replaced the position-only heuristic with a direction-aware one: programmatic scrolls are flagged and ignored, any user-initiated `scrollTop` *decrease* (wheel / touch / keyboard) immediately disengages stick mode, and stick mode only re-engages when the user lands within 8 px of the bottom on their own.

## [0.3.7]

### Fixed
- Conversation-end detection no longer relies solely on the SSE `session.idle` event. A 30-second watchdog now polls `client.session.status({ directory })` when no events have been seen during a busy turn — if opencode reports `idle`, the host emits `sessionIdle` itself. Previously a dropped SSE connection, a server crash mid-turn, or a reconnect after the idle event fired could leave the UI stuck on "Working…" forever. The watchdog resets on every routed event and only fires while busy.
- `assistantEnd` for a per-message `finish: "stop"` (or any non-`tool-calls` reason) is now also gated on the message having no active tool parts. Some providers return `finish: "stop"` while the assistant message still has running tool calls; the previous check only looked at the finish reason and cleared the per-message spinner prematurely. Matches opencode's own loop-exit condition in `packages/opencode/src/session/prompt.ts`.

## [0.3.6]

### Fixed
- Status-bar text ("connecting…" / "error · …") now sits on the same horizontal centerline as the dot and the right-side icons. The text inherited the bar's default `line-height` (~1.2), which inflated its text-box; `align-items: center` then landed the geometric centre of the inflated box a hair above the dot's centre. Pinned `line-height: 1` on `.statusbar .status-text` and made `.dot` `display: inline-block` so its `<span>` doesn't pick up baseline quirks.

## [0.3.5]

### Fixed
- Status-bar connection dot stays perfectly round at narrow side-panel widths. The dot is a flex item inside `display: flex; flex-direction: row` and had default `flex-shrink: 1`, so the algorithm squeezed its width below 8 px while keeping height at 8 px — a vertical ellipse. Added `flex: 0 0 auto`. Same defensive `flex: 0 0 auto` added to `.msg-stopped::before` (the dot on Stopped assistant messages) since it lives in an `inline-flex` parent.

## [0.3.4]

### Fixed
- Edit-in-place user bubble no longer goes transparent when the mouse leaves it. The `.is-editing` rule previously only had `background: transparent` and relied on the `.is-editable:hover` rule to layer in an opaque fill — once the mouse moved off, the bubble's fill vanished and chat content scrolling behind the sticky bubble showed through. Now the editing bubble carries an explicit `--vscode-input-background` fill at rest.

### Changed
- Edit-in-place is now compact and self-dismissing. The "Save & regenerate" button is now the same circular Send icon used in the regular prompt box (accessible name `"Save & regenerate"` preserved). The Cancel button is gone — clicking anywhere outside the edit container cancels and returns to view mode, matching the existing Escape behavior. Outer bubble padding tightened from 8 px → 4 px so the textarea + Save button feel like a single in-place editor.

## [0.3.3]

### Fixed
- Question reply / reject now sends a `directory=<workspace>` query parameter so the request lands in the correct workspace's pending-questions map. Without it, opencode's `WorkspaceRoutingMiddleware` routed the reply to a default workspace where the pending request didn't exist; opencode logged "reply for unknown request" and the original `Question.ask` Effect stayed blocked, leaving the chat stuck "Working…" after Send. Also tightened logging — both reply and reject now log the request URL and the response status / body so failures aren't silent anymore.

## [0.3.2]

### Fixed
- Handle opencode's `message.removed` SSE event. When opencode drops a message from a session (revert, redo, internal truncation) — including via our own edit-and-regenerate / Retry flows — the matching row is now dropped from the webview state. If the removed message was the only pending one, the `busy` flag clears so the prompt input re-enables. Previously a ghost "Working…" indicator could linger until the user manually cleared the chat.
- Render Hephaestus-style `system-reminder` **tool blocks** as the same expanded `<SystemReminderCallout>` used for inline text-tag reminders. Previously these slipped into the generic tool trace with the literal tool name as the title (e.g. a row reading `<system-reminder> ›` whose body was empty until expanded). The reminder text is now extracted from `output` / `input.{text,content,message,reminder,body,value}` / `title` and shown directly in the chat. Inside the trace panel (`processMode`) they're stripped entirely, matching the inline-form behavior.
- `ProcessPanel` titles no longer leak `<system-reminder>` (or other raw scaffold tags) as the headline. `processTitle` now strips internal markers from the source text before deriving a title; `textTitle` defensively rejects strings that look like literal HTML tags. `hasProcessBlocks` also treats reminder-only / scaffold-only text and reasoning blocks as empty so a message containing nothing but a reminder doesn't render as an empty collapsible panel.
- Toast dedup no longer breaks on spinner-frame animations or countdown timers. Some agents animate spinners (`·`, `•`, `●`, `○`, `◌`, `◦`, …) and emit countdown updates (`Resuming in 2s…`, `Resuming in 1s…`) as repeated toasts. The dedup key now strips leading punctuation/symbols, replaces digit runs with `N`, and lowercases before comparing — all spinner/countdown variants now collapse into a single popup.
- Per-message `model · cost · tokens` usage line is now hidden while the chat is overall busy. Hephaestus-style agents emit multi-step turns where every finished sub-task carries its own usage; rendering those mid-flight made completed sub-tasks sit next to the still-running ProcessPanel and the chat looked both finished and working at the same time. Usage appears once everything settles. (Intermediate `processOnly` messages still suppress usage even when the chat is idle, since their compact panel header is meant as a summary.)

### Added
- Surface opencode `tui.toast.show` events as VS Code notifications. **Warnings** route to `showWarningMessage`, **errors** route to `showErrorMessage`. **Info / success** toasts go to the OpenCode Panel output channel only (typically "MCP server connected" / "added N tools" chatter). All toasts are logged. Consecutive identical toasts within 3 seconds are coalesced — Hephaestus and similar deep agents fire bursts and we drop the repeats.

## [0.3.1]

### Changed
- `<system-reminder>` callouts in assistant messages now render expanded by default, with the title "System reminder" above the body. Previously the body was collapsed and required clicking the chevron. The fold/unfold affordance is still there — click the title to collapse if the reminder is noisy. The redundant first-line preview next to the title was dropped since the body is now visible.

## [0.3.0]

### Added
- **Question dialog for agents that ask for input.** opencode 1.14.41+ (and agents like Hephaestus that depend on it) emits `question.asked` SSE events when the assistant wants the user to choose between options or supply a free-text answer mid-stream. The webview now renders a sticky dialog with the question text, suggested options (single- or multi-select via `multiple`), an optional free-text input (when `custom !== false`), a "Send" button, and a "Skip" button. Replies POST to opencode's `/question/:id/reply` endpoint; rejects POST to `/question/:id/reject`. Companion `question.replied` / `question.rejected` events from other clients clear our local dialog. Without this, sessions that hit a question silently hung "Working…" forever until the user aborted.

### Fixed
- Retry button's reconstructed attachments now include a synthetic `id` field. Previously TypeScript flagged this as an error; the runtime behavior is unchanged (the host only consumes mime/filename/dataUrl/sourcePath when forwarding the attachment).

## [0.2.0]

### Added
- **Retry button on stopped messages.** When you press Stop, the assistant message gets a small "Retry" button inline with the "● Stopped" badge. Clicking it reverts the session to before the stopped response and re-sends the preceding user prompt verbatim — same text, same mentions, same attachments. The partial response is discarded and the LLM starts fresh. The button is hidden while another message is in flight.
- **Attach code and text files.** The paperclip Attach button now accepts a curated set of ~50 common code / plain-text extensions in addition to images and PDFs — `.txt`, `.md`, `.json`, `.js` / `.ts`, `.py`, `.go`, `.rs`, `.yml`, `.html`, `.sh`, and so on. The file dialog adds a "Code & text" filter group and an "All supported" default. Each attached file is forwarded to opencode via its `file://` source path; the LLM sees both the filename and the content. In the message bubble, non-image attachments now render with a small extension badge (`MD`, `JSON`, `PDF`, …) instead of always saying "PDF".

### Changed
- **PromptBox Send / Stop buttons are now circular icon buttons.** The "Send" text button became an 18px circle with a thin ring and an upward arrow, both in `--vscode-descriptionForeground` so it sits quietly against the chat content. The "Stop" / "Stopping…" busy-state buttons use the same circle with a filled square inside; while the LLM is mid-stream the Stop button gently pulses an outward ring so it reads as "actively running, click to interrupt". Hover scales the icons up to 1.08 and brightens the ring + icon to the full foreground color; `prefers-reduced-motion: reduce` disables both the transitions and the pulse. Accessible names stay "Send" / "Stop" / "Stopping…" via `aria-label` so existing PromptBox tests still match. The "Save & regenerate" and "Cancel" buttons inside the edit-in-place variant are unchanged.

## [0.1.4]

### Fixed
- Model · Agent popover no longer overflows the sidebar's left edge at narrow widths. Both popovers now anchor to `.statusbar` itself instead of their individual menu wrappers, with `right: 10px` matching the statusbar's right padding. Identical width-and-right math now lands both popovers in the same place. The history popover is visually unchanged (it was already at the bar's right edge).

## [0.1.3]

### Changed
- Compacted the Model · Agent trigger button by hiding the "MODEL" / "AGENT" prefix labels. The button now reads as just `<model> · <agent>` (e.g. `Sonnet 4.7 · Default`), which takes less horizontal space and leaves more room for the "New chat" and "Chat history" icons on narrow side panels. The full information is still available via the trigger's hover tooltip.

## [0.1.2]

### Fixed
- Release workflow: now installs webview deps before running tests, so the auto-publish workflow can reach the `vsce publish` step. No user-visible change vs 0.1.1; v0.1.1 was tagged but never reached the Marketplace because the workflow failed earlier.

## [0.1.1]

### Fixed
- Chat history popover: title, time, Rename and Delete now sit on the same horizontal line. Replaced baseline alignment with center alignment on the row's "open" button and normalized font-sizes / line-heights across the four elements.

### Changed
- Moved the "New chat" action from below the popover title to the right side of the title row, so the popover header now reads "Chat history … + New chat" on a single line.

## [0.1.0] — Initial release

### Chat
- Sidebar chat panel powered by opencode's HTTP/SSE backend via `@opencode-ai/sdk`, with streaming responses, reasoning blocks, and an inline tool-call trace.
- Sticky user message: the most recent question pins to the top of the conversation while the AI streams its answer; hand-off between turns is bounded per-turn so multiple sticky bubbles do not overlap.
- Edit + regenerate previous prompts: clicking a past user message opens a full PromptBox in place (mentions, attachments, picker preserved) and rewinds via `session.revert`.
- `@file` mentions: type `@` for a fuzzy workspace file picker with recent-tabs boost. Inserted paths render as inline highlighted chips (transparent textarea over a backdrop with `<span class="mention-chip">`). Two-step Backspace at the chip's right edge highlights it, second press deletes the whole token.
- Image / PDF attachments: paperclip button opens VS Code's native file dialog (filtered to `png/jpg/jpeg/gif/webp/bmp/svg/pdf`). Files insert as inline `@filename` chips at the caret and forward to opencode as `FilePartInput` with `file://` URLs. Same-name files get disambiguated labels. Per-file cap 10 MB, total 25 MB.
- Welcome screen with one-click suggestion prompts.
- Inline edit (`Cmd+K` / `Ctrl+K`): rewrite the active selection with a natural-language instruction.
- IME-aware Enter: pressing Enter to commit a Chinese / Japanese / Korean composition no longer accidentally sends the message.

### Conversation rendering
- Per-file tool trace: file ops are grouped (one row per file regardless of how many calls touched it). Reads collapse to `Read N: foo.ts, bar.ts`; edits get bordered cards with `+N −N` stats.
- Inline Todos: when the AI updates its plan via `todowrite`, the todo block renders inline with status-colored dots and a `N/N` progress count.
- Code blocks: Shiki syntax highlighting, `Copy`, and a context-aware action button: `Run` for shell snippets (routes to the integrated terminal), `Apply` for code (replaces the active selection/file, undo via `Cmd+Z`).
- Collapsible `<system-reminder>` callouts: internal scaffolding tags are rendered as folded `<details>` blocks instead of leaking into chat content. Other internal markers (HTML comments, `command-name` tags) are stripped.
- Stopped messages render as a neutral grey "● Stopped" badge instead of a red error block. Legacy persisted `error: "Aborted"` strings are auto-normalized.

### Review changes card
- One row per file with cumulative `+N −N` aggregated across multiple edits in the same conversation.
- File-kind colors: green for created, strikethrough red for deleted, yellow for moved. Basename collisions are disambiguated with the shortest unique path suffix.
- Per-row `Keep` / `Undo` (hover-revealed) plus panel-level `Keep all` / `Undo all` for multi-file changes.
- Click a row to open the file in the editor; rapid clicks are debounced so the editor swap fires once.
- Auto-purge for files deleted outside the AI's edits.

### Status bar
- Combined Model · Agent selector with pretty-printed long names (`claude-3-5-sonnet-20241022` → `Sonnet 3.5`, `code-reviewer` → `Code Reviewer`).
- History popover: searchable list (search appears at 5+ chats), relative time (`just now`, `5m ago`, `yesterday`, `Mar 5`), inline rename, two-click delete confirmation.
- Per-workspace conversation storage with one-shot migration from the legacy global storage.
- Internal opencode agents (`compaction`, `summary`, `title`) are hidden from the agent picker.

### Abort flow
- Stop button transitions to a disabled "Stopping…" state until opencode emits `session.idle`. While aborting, in-flight `textDelta` / `reasoningDelta` events are dropped so the stopped message does not keep growing.

### Backend management
- Single `opencode serve` subprocess per workspace, owned by the extension. Auto-restart via `OpenCode Panel: Restart Backend`.
- Configurable `opencui.binaryPath` (defaults to `opencode` on PATH) and `opencui.serverPort` (`0` for auto).

### Tests
- 360+ tests across four phases: unit (Vitest + node/jsdom), integration (`@vscode/test-electron`), component (Vitest + React Testing Library), and E2E against a mock opencode HTTP/SSE server.

[Unreleased]: https://github.com/arthurzengg/opencui/compare/v0.3.9...HEAD
[0.3.9]: https://github.com/arthurzengg/opencui/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/arthurzengg/opencui/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/arthurzengg/opencui/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/arthurzengg/opencui/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/arthurzengg/opencui/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/arthurzengg/opencui/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/arthurzengg/opencui/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/arthurzengg/opencui/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/arthurzengg/opencui/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/arthurzengg/opencui/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/arthurzengg/opencui/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/arthurzengg/opencui/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/arthurzengg/opencui/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/arthurzengg/opencui/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/arthurzengg/opencui/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/arthurzengg/opencui/releases/tag/v0.1.0
