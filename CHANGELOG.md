# Changelog

All notable changes to OpenCode Panel are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.7]

### Added
- **Attach code and text files.** The paperclip Attach button now accepts a curated set of ~50 common code / plain-text extensions in addition to images and PDFs — `.txt`, `.md`, `.json`, `.js` / `.ts`, `.py`, `.go`, `.rs`, `.yml`, `.html`, `.sh`, and so on. The file dialog adds a "Code & text" filter group and an "All supported" default. Each attached file is forwarded to opencode via its `file://` source path; the LLM sees both the filename and the content. In the message bubble, non-image attachments now render with a small extension badge (`MD`, `JSON`, `PDF`, …) instead of always saying "PDF".

## [0.1.6]

### Changed
- **PromptBox Send / Stop buttons are now circular icon buttons.** The "Send" text button became a 22px circle with a white outline and a white upward arrow; the circle's fill matches the surrounding sidebar background, so the button reads as a white-ringed icon rather than a solid pill (matching the size of the New chat and Chat history icons in the statusbar). The "Stop" / "Stopping…" busy-state buttons became the same circle with a filled square in the danger color. Accessible names stay "Send" / "Stop" / "Stopping…" via `aria-label`. The "Save & regenerate" and "Cancel" buttons inside the edit-in-place variant are unchanged.

## [0.1.5]

### Added
- **Retry button on stopped messages.** When you press Stop, the assistant message gets a small "Retry" button inline with the "● Stopped" badge. Clicking it reverts the session to before the stopped response and re-sends the preceding user prompt verbatim — same text, same mentions, same attachments. The partial response is discarded and the LLM starts fresh. The button is hidden while another message is in flight.

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

[Unreleased]: https://github.com/arthurzengg/opencui/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/arthurzengg/opencui/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/arthurzengg/opencui/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/arthurzengg/opencui/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/arthurzengg/opencui/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/arthurzengg/opencui/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/arthurzengg/opencui/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/arthurzengg/opencui/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/arthurzengg/opencui/releases/tag/v0.1.0
