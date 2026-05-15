# Changelog

All notable changes to OpenCode Panel are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0]

### Added
- Model picker now surfaces effort / thinking-budget variants. opencode's `/config/providers` response carries a `variants` field on most modern models (e.g. `openai/gpt-5.5` has `none/minimal/low/medium/high/xhigh`, `anthropic/claude-opus-4-7` has `low/medium/high/xhigh/max`, `anthropic/claude-haiku-4-5` has token-budget-based `high/max`) — the previous picker enumerated only model IDs and dropped this entirely, so users couldn't tune reasoning effort without editing `opencode.json`. The picker now emits one row per `(provider, model, variant)` triple: the bare model row first (the model's default variant), then one row per variant key, formatted as `provider/model · variant`. Selection persists across reloads, the status bar shows the active variant (`gpt-5.5 · high`), and the variant is sent on the prompt body as a sibling of `modelID` — matching opencode's wire protocol (`packages/opencode/src/session/prompt.ts:2070,2102`). Models with no variants are unchanged. The bundled `@opencode-ai/sdk` TS types don't yet expose the `variant` field; the HTTP server accepts it regardless, so the prompt body is cast at the dispatch site. Closes #46.

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
