/**
 * Message protocol between the VS Code extension (host) and the React webview.
 * Keep this file identical in both sides. The host imports via relative path.
 */

export type ToolStatus = "pending" | "running" | "completed" | "error"
export type ReviewHunkState = "accepted" | "rejected"

/**
 * Who produced a file change. `main` is the parent assistant session;
 * `subagent` is any child session dispatched via `task` / `call_omo_agent`
 * / etc. `sessionID` is the child opencode session for subagent rows;
 * `subagent` is the agent slug (e.g. `explore`, `hephaestus`) when omo's
 * tool metadata surfaced it. Multiple actors can contribute to the same
 * path — see `ReviewChange.actors`.
 */
export type ReviewChangeActor = {
  kind: "main" | "subagent"
  sessionID?: string
  subagent?: string
}

export type ReviewChange = {
  source: string
  path: string
  kind: "created" | "updated" | "deleted" | "moved"
  additions: number
  deletions: number
  patch: string
  /**
   * Set when `kind === "moved"`. The pre-move path of the file. Used by
   * Undo to restore the file at its original location.
   */
  oldPath?: string
  /**
   * Absolute filesystem path reported by opencode when available
   * (apply_patch's `files[].absolutePath` / `filename` / `path` if any of
   * those is absolute). Display continues to use `path`; the host resolver
   * uses this as a preferred candidate so relative paths anchored ABOVE
   * the VS Code workspace resolve correctly without relying on the
   * ancestor-walk heuristic.
   */
  absolutePath?: string
  /**
   * Attribution for the change. Always at least one entry; aggregated
   * changes accumulate one entry per contributing actor. Older clients
   * may not set this — consumers should treat empty as "main".
   */
  actors?: ReviewChangeActor[]
}

export type ToolUpdate = {
  callID: string
  tool: string
  status: ToolStatus
  title?: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
  output?: string
  error?: string
}

export type QuestionOption = { label: string; description: string }
export type QuestionInfo = {
  question: string
  header: string
  options: QuestionOption[]
  /** Allow selecting multiple options (default false). */
  multiple?: boolean
  /** Allow typing a custom free-text answer (default true). */
  custom?: boolean
}

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  /**
   * `actor` identifies whether the tool ran on the main session or a child
   * subagent session. Absent / `kind === "main"` means main. Subagent tool
   * blocks are appended to the dispatching parent message so review-card
   * aggregation walks them naturally.
   */
  | { type: "tool"; update: ToolUpdate; actor?: ReviewChangeActor }
  | { type: "patch"; files: string[]; diff?: string; actor?: ReviewChangeActor }
  /**
   * `dataUrl` is transient display data (image `<img>` previews): present on
   * the wire and in memory, stripped from persistence whenever `storageID`
   * points at the bytes in the host-side attachment store. Blocks persisted
   * before the store existed carry `dataUrl` and no `storageID`.
   */
  | { type: "attachment"; mime: string; filename: string; dataUrl?: string; bytes: number; storageID?: string }

export type ChatMessage = {
  id: string
  role: "user" | "assistant"
  blocks: ChatBlock[]
  ref?: EditorContextRef
  pending?: boolean
  error?: string
  usage?: UsageDelta
  backendID?: string
  /**
   * True when the user pressed Stop while this assistant message was streaming.
   * Rendered as a neutral grey "Stopped" badge instead of the red error block.
   * Distinct from `error`, which signals a real failure.
   */
  stopped?: boolean
  /**
   * True when this assistant message is opencode's compaction summary turn
   * (`AssistantMessage.summary` in the SDK). Rendered as a collapsed
   * "Conversation compacted" marker instead of a normal reply bubble.
   */
  summary?: boolean
  /**
   * @-mention paths the user originally selected when this message was sent.
   * Persisted on the message so the edit flow can preserve them — when the
   * user clicks an old user message to revise it, we know which `@path`
   * tokens in the text should still be treated as file context attachments.
   */
  mentions?: string[]
  /**
   * Past-conversation chips the user attached via the @ picker, each with
   * the label it renders as in `text`. Persisted so the edit flow can
   * restore them. Messages persisted before the pair shape carried bare id
   * arrays; the ConversationManager normalizes those to pairs at read time.
   */
  conversationMentions?: ConversationMention[]
  /**
   * Manifest of context the host attached when this turn was sent. Persisted
   * so historical messages can show what was included. Always set for new
   * messages, undefined for messages from before the manifest landed.
   */
  context?: PromptContextManifest
}

export type ConversationSummary = {
  id: string
  title: string
  updatedAt: number
}

/**
 * A past-conversation @-mention: the chip label exactly as it appears in the
 * message text, bound to the conversation it references. Carried as a pair
 * end to end so the edit flow restores label→id bindings by lookup —
 * reconstructing them from the text desyncs from insertion order (a chip can
 * be inserted ahead of an existing one) and from any filtered id list.
 */
export type ConversationMention = {
  label: string
  id: string
}

export type Todo = {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority?: string
}

export type UsageDelta = {
  model?: string
  providerID?: string
  modelID?: string
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cacheRead?: number
    cacheWrite?: number
  }
}

export type ContextUsage = {
  tokens: number
  percent?: number
  limit?: number
  model?: string
  cost?: number
}

export type Selection = {
  agent?: string
  /** Bare `provider/modelID`, without any variant suffix. */
  model?: string
  /**
   * Selected effort/thinking variant for the current model (e.g. `high`,
   * `xhigh`, `max`). Undefined means "use the model's default variant".
   * Sent as a sibling of `model` so the StatusBar can render an Effort
   * row without re-parsing the model string.
   */
  modelVariant?: string
}

export type EditorContextRef = {
  path?: string
  label?: string
}

/**
 * Workspace root the host is currently operating against. Undefined means no
 * folder is open — automatic context features should treat that as a no-op
 * state. Phase 2+ of the workspace-context plan attaches a richer manifest
 * per prompt; this `workspace` message is the unconditional "what root are
 * we in?" surface the UI uses today.
 */
export type WorkspaceInfo = {
  name: string
  /** Absolute filesystem path of the workspace root. */
  root: string
  /** True for the first folder in a multi-root workspace. */
  isDefault: boolean
  /** True when this workspace is one of several open folders. */
  multiRoot: boolean
  /** Active opencode config-mode the running server was started with. */
  configMode?: "isolated" | "user"
}

export type FileSearchHit = { path: string; name: string }

/**
 * One immediate child of a folder, used by the @-picker's drill-down browser.
 * `path` is workspace-relative; folders are navigation-only (never inserted as
 * a mention), files are the selectable leaves.
 */
export type DirEntry = { name: string; path: string; kind: "file" | "folder" }

/**
 * One opencode custom command surfaced to the `/` picker. The host strips the
 * `template` (it is expanded server-side by `session.command`) and keeps only
 * what the picker renders + needs. `takesArguments` drives the smart run UX: a
 * template containing `$ARGUMENTS` waits for the user to type args, otherwise
 * the command runs the moment it is selected. `agent` is a display-only hint;
 * the agent/model actually used are read host-side from prefs at run time.
 * `allowedWhileBusy` marks commands that never touch the running session turn
 * (they open native pickers or switch conversations), so the composer lets
 * them through the busy block that swallows turn-bound commands.
 */
export type CommandInfo = { name: string; description?: string; agent?: string; takesArguments: boolean; allowedWhileBusy?: boolean }

/**
 * Status snapshot of the optional semantic index — Phase 6 of the
 * workspace-context plan. `disabled` is the default; flipping
 * `opencui.indexing.semantic.enabled` true plus configuring a real
 * embedding provider moves through `scanning` → `ready`.
 */
export type IndexStatusInfo = {
  state: "disabled" | "idle" | "scanning" | "ready" | "error"
  chunks?: number
  message?: string
  updatedAt: number
}

/**
 * One agent task as seen by the webview popover. The host strips
 * conversationID / sessionID / messageID / parentTaskID / callID before
 * sending because the popover only needs to render — it doesn't action
 * on those fields.
 */
export type AgentsTaskInfo = {
  id: string
  kind: "main" | "subagent"
  title: string
  /**
   * Only currently-active states reach the wire. The host filters out
   * `completed` / `cancelled` in `summarizeAgentTasks` so the popover
   * reflects "what's happening right now," not a per-chat history.
   * `error` is kept because it needs attention until cleared.
   */
  status: "running" | "waiting" | "error"
  error?: string
  startedAt: number
  /**
   * Last state-change timestamp. For terminal rows this is the
   * effective endedAt — the AgentsRow uses `updatedAt - startedAt` to
   * render a frozen total runtime instead of "X seconds since the row
   * mounted". For live rows this just keeps refreshing; the live
   * elapsed display ticks off `Date.now()` instead.
   */
  updatedAt: number
  /**
   * Subagent slug (`explore` / `librarian` / `oracle` / `hephaestus` /
   * `prometheus` / …). Set only for subagent rows where omo's tool
   * metadata surfaced it; main-agent rows leave this undefined because
   * the StatusBar already displays the user's primary agent next to
   * the model selector.
   */
  subagent?: string
  /** Category slug like `deep`, `quick`, `ultrabrain` when the
   * subagent was dispatched via category-based routing. */
  category?: string
  /** Resolved model — same shape opencode reports on the assistant
   * message; the StatusBar will prettify it through `formatModel`. */
  model?: { providerID: string; modelID: string }
}

/**
 * Snapshot of live main-agent + subagent activity for the currently-active
 * conversation, driven by the host-side AgentTaskStore. The webview header
 * renders an `Agents` pill that is hidden when `total === 0` and breathes
 * green while `running > 0`. Clicking the pill opens a popover that lists
 * `tasks` grouped by kind.
 */
export type AgentsStatusInfo = {
  running: number
  waiting: number
  error: number
  total: number
  tasks: AgentsTaskInfo[]
}

/**
 * Per-prompt manifest of what context the host attached to a user turn.
 * Built by the host in `src/workspace-context/manifest.ts`, rendered by the
 * `ContextManifest` component in the user-message bubble. Persisted on
 * `ChatMessage.context` so historical turns can still surface what they
 * actually sent. Phases 3+ append more items (collectors, semantic hits);
 * the shape stays stable.
 */
export type PromptContextManifest = {
  version: 1
  workspace?: WorkspaceInfo
  opencode?: {
    directory?: string
    configMode: "isolated" | "user"
    /**
     * Best-effort list of tool families opencode is *expected* to expose for
     * this turn (populated in Phase 5). Concrete tool calls are classified
     * after the fact via the wire-format pass.
     */
    toolFamilies?: string[]
  }
  totals: {
    includedItems: number
    skippedItems: number
    truncatedItems: number
    includedBytes: number
    /** Phase 4+ budget; 0 means "no budget enforced yet". */
    budgetBytes: number
  }
  items: PromptContextManifestItem[]
}

export type PromptContextManifestItemSource =
  | "editor"
  | "mention"
  | "attachment"
  | "openTab"
  | "git"
  | "diagnostic"
  | "recentEdit"
  | "doc"
  | "symbol"
  | "semantic"
  | "opencode"
  | "omo"
  | "external"
  | "conversation"

export type PromptContextManifestItemKind =
  | "file"
  | "selection"
  | "snippet"
  | "diff"
  | "diagnostic"
  | "symbol"
  | "summary"
  | "indexResult"
  | "conversation"

export type PromptContextManifestItem = {
  id: string
  source: PromptContextManifestItemSource
  kind: PromptContextManifestItemKind
  label: string
  path?: string
  root?: string
  reason: string
  status: "included" | "skipped" | "truncated" | "available"
  bytes?: number
  budgetBytes?: number
  external?: boolean
  priority?: number
}

export type Attachment = {
  /** Stable id used to dedup / remove an attachment in the prompt UI. */
  id: string
  mime: string
  filename: string
  /**
   * `data:<mime>;base64,...` — used for `<img src>` previews. Optional: an
   * attachment rebuilt from a restored non-image block carries only its
   * `storageID`; the host resolves the bytes from the attachment store.
   */
  dataUrl?: string
  /** Bytes of the underlying file (for size display + cap enforcement). */
  bytes: number
  /**
   * Absolute filesystem path on the host. When present we forward `file://<sourcePath>`
   * to opencode so the LLM can read the file directly (works for files outside
   * the workspace too). Stays optional because restored attachments from older
   * conversations may not have it.
   */
  sourcePath?: string
  /** Reference into the host-side attachment store (see the block doc above). */
  storageID?: string
}

/** Messages sent from the extension host to the webview. */
export type Outbound =
  | { type: "ready"; connected: boolean; selection: Selection }
  | { type: "connected"; connected: boolean; error?: string }
  | { type: "selection"; selection: Selection }
  | { type: "contextUsage"; usage?: ContextUsage }
  | { type: "commands"; commands: CommandInfo[] }
  | { type: "conversations"; conversations: ConversationSummary[]; activeID?: string }
  | { type: "restore"; conversationID: string; messages: ChatMessage[]; reviewHunks?: Record<string, ReviewHunkState> }
  | { type: "context"; ref: EditorContextRef }
  | { type: "workspace"; workspace?: WorkspaceInfo }
  | { type: "userMessage"; id: string; text: string; ref?: EditorContextRef; backendID?: string; attachments?: Attachment[]; mentions?: string[]; conversationMentions?: ConversationMention[]; context?: PromptContextManifest }
  | { type: "userMessageBackendID"; id: string; backendID: string }
  /**
   * Followup to `userMessage` after the host finishes reading mentions and
   * builds the full manifest. Sent as a separate event so the user message
   * bubble appears instantly (no waiting on file I/O) and the manifest pill
   * fills in once the host knows the included/truncated/skipped state.
   */
  | { type: "userMessageContext"; id: string; context: PromptContextManifest }
  | { type: "assistantStart"; id: string }
  | { type: "assistantSummary"; id: string }
  | { type: "textDelta"; id: string; delta: string }
  | { type: "reasoningDelta"; id: string; delta: string }
  | { type: "tool"; id: string; update: ToolUpdate; actor?: ReviewChangeActor }
  | { type: "patch"; id: string; files: string[]; diff?: string; actor?: ReviewChangeActor }
  | { type: "reviewHunkState"; key: string; state?: ReviewHunkState }
  | { type: "assistantError"; id: string; message: string }
  | { type: "assistantDone"; id: string; usage?: UsageDelta }
  | { type: "aborted" }
  | { type: "sessionBusy" }
  | { type: "sessionIdle" }
  /**
   * Sent when the host is deferring a `sessionIdle` because a continuation
   * is imminent (background subagents running, or a continuation toast
   * recently observed). The webview should treat this as "still busy but
   * waiting on the next turn" — keep busy true, surface a "Continuing…"
   * indicator. Cleared by a subsequent `sessionBusy` / `assistantStart`
   * (continuation took over) or `sessionIdle` (defer timed out).
   */
  | { type: "continuationPending"; pending: boolean }
  | { type: "permission"; id: string; title: string; pattern?: string | string[] }
  | { type: "question"; id: string; questions: QuestionInfo[] }
  | { type: "questionResolved"; id: string }
  | { type: "messageRemoved"; id: string }
  // Host -> webview: replace the live composer's text (e.g. /undo restoring the
  // undone prompt, /redo clearing it). Applied to the bottom send composer only.
  | { type: "setComposerText"; text: string }
  | { type: "indexStatus"; status: IndexStatusInfo }
  | { type: "agentsStatus"; status: AgentsStatusInfo }
  | { type: "fileSearchResult"; requestID: number; hits: FileSearchHit[] }
  | { type: "listDirResult"; requestID: number; entries: DirEntry[] }
  | { type: "attachmentResult"; requestID: number; attachments: Attachment[]; error?: string }
  | { type: "clear" }

/** Messages sent from the webview to the extension host. */
export type Inbound =
  | { type: "mounted" }
  | { type: "send"; text: string; mentions?: string[]; attachments?: Attachment[]; conversationMentions?: ConversationMention[] }
  | { type: "runCommand"; command: string; arguments: string }
  | { type: "editMessage"; id: string; text: string; mentions?: string[]; attachments?: Attachment[]; conversationMentions?: ConversationMention[] }
  | { type: "abort" }
  | { type: "newSession" }
  | { type: "createConversation" }
  | { type: "openConversation"; id: string }
  | { type: "renameConversation"; id: string; title: string }
  | { type: "deleteConversation"; id: string }
  | { type: "apply"; code: string; language?: string }
  | { type: "openFile"; path: string }
  | { type: "openReviewChange"; change: ReviewChange }
  | { type: "reviewAllInChange"; source: string; path: string; action: ReviewHunkState }
  | { type: "selectAgent" }
  | { type: "selectModel" }
  | { type: "selectVariant" }
  | { type: "fileSearch"; requestID: number; query: string }
  | { type: "listDir"; requestID: number; path: string }
  | { type: "attachFile"; requestID: number }
  | { type: "permissionReply"; id: string; response: "once" | "always" | "reject" }
  | { type: "questionReply"; id: string; answers: string[][] }
  | { type: "questionReject"; id: string }
  | { type: "startIndex" }
  | { type: "stopIndex" }
