import * as vscode from "vscode"

export const AGENT_TASKS_KEY = "opencui.agentTasks"

export type AgentTaskStatus =
  | "running"
  | "waiting"
  | "completed"
  | "error"
  | "cancelled"

export type AgentTaskKind = "main" | "subagent"

/**
 * Subset of opencode/omo metadata we mirror onto a task record so the
 * Agents popover can show *what kind* of subagent is running and on
 * which model. All fields are best-effort — opencode's built-in `task`
 * tool may not populate every field, and third-party plugins might
 * write nothing at all. Consumers MUST treat each field as optional.
 */
export type AgentTaskModel = {
  providerID: string
  modelID: string
}

export type AgentTask = {
  id: string
  kind: AgentTaskKind
  conversationID: string
  /**
   * For a `main` task: the parent opencode sessionID.
   * For a `subagent` task: the parent sessionID (kept so we can scope by
   *   conversation). The subagent's *own* sessionID lives in
   *   `childSessionID` and is populated as soon as omo's tool metadata
   *   surfaces it (one or two SSE frames after the tool dispatch).
   */
  sessionID: string
  messageID?: string
  callID?: string
  parentTaskID?: string
  /**
   * The opencode sessionID of the subagent's own session. Populated from
   * `update.metadata.sessionId` (omo writes both `sessionId` and `taskId`
   * to the same value). Used as the canonical identity once known — the
   * task is re-keyed from `subagent:<parent>:<callID>` to
   * `subagent:child:<childSessionID>` to survive task_id-reuse follow-ups.
   */
  childSessionID?: string
  /**
   * omo's internal BackgroundManager task id. Distinct from the
   * opencode sessionID. We keep it so the QuickPick / popover can
   * show it for debugging and so future "cancel background task"
   * actions have a handle.
   */
  backgroundTaskID?: string
  /** Subagent slug like `explore`, `librarian`, `oracle`, `hephaestus`. */
  subagent?: string
  /** Category slug like `deep`, `quick`, `ultrabrain`. */
  category?: string
  /** Resolved model used for this subagent's session. */
  model?: AgentTaskModel
  /** True when omo dispatched this task with `run_in_background=true`. */
  runInBackground?: boolean
  title: string
  status: AgentTaskStatus
  startedAt: number
  updatedAt: number
  error?: string
}

/**
 * `running` and `waiting` are the statuses that mean opencode is still
 * doing work for this task. Consulted by `markSessionIdle` / abort paths
 * to decide which tasks to settle on session close.
 */
export type ActiveStatus = "running" | "waiting"
export const ACTIVE_STATUSES: ReadonlyArray<AgentTaskStatus> = ["running", "waiting"]

/**
 * Statuses the Agents popover shows. Active work plus `error` so a
 * failed task stays visible until the user starts the next turn. Exported
 * so call sites (e.g. `summarizeAgentTasks` in `src/agents/summary.ts`) iterate
 * the same set and `isAttentionStatus` narrows the union, instead of
 * duplicating the membership check inline.
 */
export type AttentionStatus = ActiveStatus | "error"
export const ATTENTION_STATUSES: ReadonlyArray<AgentTaskStatus> = ["running", "waiting", "error"]

export function isAttentionStatus(status: AgentTaskStatus): status is AttentionStatus {
  return ATTENTION_STATUSES.includes(status)
}

/**
 * One main task per user turn. `turnID` is minted by ChatView at prompt
 * submit time so a second message in the same conversation gets its own
 * row instead of trying to resurrect the previous (terminal) one. The
 * terminal-guard in `upsert` blocks revival by design, so we sidestep it
 * by issuing a fresh identity.
 */
export function mainTaskID(conversationID: string, sessionID: string, turnID: string): string {
  return `main:${conversationID}:${sessionID}:${turnID}`
}

/**
 * Pre-metadata identity for a subagent: we know which parent + callID
 * dispatched it but not yet the child session. The tracker promotes the
 * record to `subagentTaskIDByChildSession` once metadata arrives.
 */
export function subagentTaskID(sessionID: string, callID: string): string {
  return `subagent:${sessionID}:${callID}`
}

/**
 * Canonical identity once the child opencode sessionID is known.
 * Keyed off the child session so task_id-reuse follow-ups (Hephaestus
 * reuses task_id by design to save 70%+ tokens) collapse into a single
 * record instead of accumulating a new row per resume.
 */
export function subagentTaskIDByChildSession(childSessionID: string): string {
  return `subagent:child:${childSessionID}`
}

/**
 * Decide whether a terminal error message represents a real failure or
 * an abort signal. opencode/omo emit the literal string "Aborted" when
 * a session is cancelled — either user-initiated (Stop button) or
 * internal (parent agent giving up on a subagent and pivoting). The
 * chat-bubble path already maps `/^aborted$/i` to a "Stopped" badge
 * rather than a red error block (see CLAUDE.md); this helper extends
 * the same convention to the popover so abort signals settle as
 * `cancelled` (filtered out of the active-only popover) instead of
 * painting the row red.
 *
 * Adding a new classification (timeout, rate-limit, quota-exceeded, …)
 * is a one-line append to `TERMINAL_CLASSIFIERS` — see
 * `docs/extensibility.md` for the recipe.
 */
type TerminalRule = {
  pattern: RegExp
  status: "cancelled" | "error"
}

const TERMINAL_CLASSIFIERS: ReadonlyArray<TerminalRule> = [
  { pattern: /^aborted$/i, status: "cancelled" },
]

export function classifyTerminal(message: string | undefined): {
  status: "cancelled" | "error"
  error?: string
} {
  const trimmed = message?.trim()
  if (trimmed) {
    for (const rule of TERMINAL_CLASSIFIERS) {
      if (rule.pattern.test(trimmed)) return { status: rule.status }
    }
  }
  return { status: "error", error: message }
}

export type Memento = Pick<vscode.Memento, "get" | "update">

/**
 * Workspace-scoped persistence + change broadcast for live agent-task state.
 * The status bar and submenu subscribe to `onDidChange`; the chat view writes
 * through `upsert` / `update`. The store does not assume any chat-view
 * internals — it just persists and broadcasts.
 *
 * Persistence is best-effort: the in-memory list is the source of truth for
 * the current process, and `update()` returns a Promise so callers can `await`
 * the write when ordering matters, but a failed write does not roll back the
 * in-memory mutation. Workspace storage on Code's side rarely fails outside
 * disk-full conditions.
 */
export class AgentTaskStore {
  private tasks: AgentTask[]
  private readonly emitter: vscode.EventEmitter<AgentTask[]>
  readonly onDidChange: vscode.Event<AgentTask[]>

  constructor(private storage: Memento) {
    this.tasks = sanitize(storage.get<AgentTask[]>(AGENT_TASKS_KEY))
    this.emitter = new vscode.EventEmitter<AgentTask[]>()
    this.onDidChange = this.emitter.event
  }

  list(): AgentTask[] {
    return [...this.tasks]
  }

  active(): AgentTask[] {
    return this.tasks.filter((task) => ATTENTION_STATUSES.includes(task.status))
  }

  hasActive(): boolean {
    return this.tasks.some((task) => ATTENTION_STATUSES.includes(task.status))
  }

  hasRunning(): boolean {
    return this.tasks.some((task) => task.status === "running")
  }

  get(id: string): AgentTask | undefined {
    return this.tasks.find((task) => task.id === id)
  }

  /** Look up a subagent by its child opencode sessionID, if known. */
  getByChildSession(childSessionID: string): AgentTask | undefined {
    return this.tasks.find(
      (task) => task.kind === "subagent" && task.childSessionID === childSessionID,
    )
  }

  /**
   * Active (running/waiting) subagent tasks belonging to the given
   * parent session. Used by ChatView as the structural continuation gate:
   * while any of these are alive, a `session.idle` event on the parent
   * must NOT clear the busy state — the parent is just waiting on its
   * subagents to finish.
   */
  activeSubagentsForSession(parentSessionID: string): AgentTask[] {
    return this.tasks.filter(
      (task) =>
        task.kind === "subagent" &&
        task.sessionID === parentSessionID &&
        ACTIVE_STATUSES.includes(task.status),
    )
  }

  hasActiveSubagentsForSession(parentSessionID: string): boolean {
    return this.activeSubagentsForSession(parentSessionID).length > 0
  }

  async upsert(task: AgentTask): Promise<void> {
    const idx = this.tasks.findIndex((t) => t.id === task.id)
    if (idx >= 0) {
      const existing = this.tasks[idx]!
      // Once a task is in a terminal state, freeze its status: ignore
      // late upserts that would either resurrect it (terminal → active)
      // OR flip it between terminal states. The second case shows up
      // when a user-initiated abort settles a subagent as `cancelled`
      // and a stray child `session.error` arrives afterwards — without
      // this guard the row flips to `error`, overriding the user's
      // explicit Stop. Same-status upserts still merge other fields.
      if (isTerminal(existing.status) && task.status !== existing.status) return
      const merged: AgentTask = {
        ...existing,
        ...task,
        startedAt: existing.startedAt,
        updatedAt: task.updatedAt,
      }
      if (sameTask(existing, merged)) return
      this.tasks = this.tasks.map((t) => (t.id === task.id ? merged : t))
    } else {
      this.tasks = [...this.tasks, task]
    }
    await this.persistAndEmit()
  }

  async update(id: string, patch: Partial<AgentTask>): Promise<void> {
    const idx = this.tasks.findIndex((t) => t.id === id)
    if (idx < 0) return
    const existing = this.tasks[idx]!
    // Same strict rule as `upsert`: once terminal, status is frozen.
    // A patch without `status` is always allowed (e.g. backfilling
    // model / metadata on a settled row); a patch that would change
    // status is rejected. See `upsert` for the abort-race motivation.
    if (isTerminal(existing.status) && patch.status && patch.status !== existing.status) return
    const next: AgentTask = { ...existing, ...patch, id, updatedAt: patch.updatedAt ?? Date.now() }
    if (sameTask(existing, next)) return
    this.tasks = this.tasks.map((t) => (t.id === id ? next : t))
    await this.persistAndEmit()
  }

  /** Drop completed/cancelled tasks. Errors are preserved until cleared explicitly. */
  async clearCompleted(): Promise<void> {
    const next = this.tasks.filter(
      (task) => task.status !== "completed" && task.status !== "cancelled",
    )
    if (next.length === this.tasks.length) return
    this.tasks = next
    await this.persistAndEmit()
  }

  async clear(id: string): Promise<void> {
    if (!this.tasks.some((t) => t.id === id)) return
    this.tasks = this.tasks.filter((t) => t.id !== id)
    await this.persistAndEmit()
  }

  /**
   * Drop every task — live or historical — belonging to a conversation.
   * Called from ChatView when the user deletes the conversation, so the
   * popover history is bounded by conversation lifetime rather than
   * accumulating forever in `workspaceState`.
   */
  async clearForConversation(conversationID: string): Promise<void> {
    const next = this.tasks.filter((t) => t.conversationID !== conversationID)
    if (next.length === this.tasks.length) return
    this.tasks = next
    await this.persistAndEmit()
  }

  /**
   * Drop a conversation's errored rows. The popover keeps a failed task
   * visible (see ATTENTION_STATUSES) only "until the user starts the next
   * turn" — this is that clearing half, called from recordMainTaskStart.
   * Removal rather than a status transition: `error` is terminal, so the
   * terminal-state guard (correctly) refuses to rewrite it, and without
   * removal the red row haunts the conversation forever.
   */
  async clearErrored(conversationID: string): Promise<void> {
    const next = this.tasks.filter(
      (task) => !(task.conversationID === conversationID && task.status === "error"),
    )
    if (next.length === this.tasks.length) return
    this.tasks = next
    await this.persistAndEmit()
  }

  /**
   * Mark every still-running/waiting *main* task for a session as completed.
   * Subagent tasks are NOT touched: their lifecycle is owned by the child
   * session's own SSE events (via SubagentTracker) — completing them here
   * would race against a background subagent that's still working after
   * the parent's LLM is done. Stale subagent rows are cleaned up by
   * `SubagentTracker.reconcile` on the next attach, by user-initiated
   * abort (which propagates to children), or by conversation switch.
   */
  async markSessionIdle(sessionID: string, now: number = Date.now()): Promise<void> {
    let changed = false
    this.tasks = this.tasks.map((task) => {
      if (task.sessionID !== sessionID) return task
      if (task.kind !== "main") return task
      if (!ACTIVE_STATUSES.includes(task.status)) return task
      changed = true
      return { ...task, status: "completed", updatedAt: now }
    })
    if (!changed) return
    await this.persistAndEmit()
  }

  /**
   * Force every still-active task for a session to settle — used for
   * user-initiated abort, which opencode propagates to child sessions
   * too. Unlike `markSessionIdle`, this DOES include subagents because
   * the user explicitly cancelled the entire turn.
   */
  async cancelSessionTasks(sessionID: string, now: number = Date.now()): Promise<void> {
    let changed = false
    this.tasks = this.tasks.map((task) => {
      if (task.sessionID !== sessionID) return task
      if (!ACTIVE_STATUSES.includes(task.status)) return task
      changed = true
      return { ...task, status: "cancelled", updatedAt: now }
    })
    if (!changed) return
    await this.persistAndEmit()
  }

  dispose() {
    this.emitter.dispose()
  }

  private async persistAndEmit(): Promise<void> {
    await this.storage.update(AGENT_TASKS_KEY, this.tasks)
    this.emitter.fire(this.list())
  }
}

function isTerminal(status: AgentTaskStatus): boolean {
  return status === "completed" || status === "error" || status === "cancelled"
}

/**
 * Deliberately ignores `updatedAt`: a write whose only difference is the
 * clock is not a change, and treating it as one turned high-frequency
 * callers (repeated `running` tool events, child busy signals) into a
 * workspaceState persist + broadcast per event. `updatedAt` is a
 * consequence of a material change — it lands whenever any compared field
 * differs, which every terminal transition does via `status`.
 */
function sameTask(a: AgentTask, b: AgentTask): boolean {
  return (
    a.status === b.status &&
    a.title === b.title &&
    a.error === b.error &&
    a.messageID === b.messageID &&
    a.callID === b.callID &&
    a.parentTaskID === b.parentTaskID &&
    a.childSessionID === b.childSessionID &&
    a.backgroundTaskID === b.backgroundTaskID &&
    a.subagent === b.subagent &&
    a.category === b.category &&
    a.runInBackground === b.runInBackground &&
    sameModel(a.model, b.model) &&
    a.kind === b.kind &&
    a.conversationID === b.conversationID &&
    a.sessionID === b.sessionID &&
    a.startedAt === b.startedAt
  )
}

function sameModel(a: AgentTaskModel | undefined, b: AgentTaskModel | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.providerID === b.providerID && a.modelID === b.modelID
}

function sanitize(raw: unknown): AgentTask[] {
  if (!Array.isArray(raw)) return []
  const out: AgentTask[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const id = typeof item.id === "string" ? item.id : undefined
    const kind = item.kind === "main" || item.kind === "subagent" ? item.kind : undefined
    const status = isStatus(item.status) ? item.status : undefined
    const conversationID = typeof item.conversationID === "string" ? item.conversationID : undefined
    const sessionID = typeof item.sessionID === "string" ? item.sessionID : undefined
    const title = typeof item.title === "string" ? item.title : undefined
    const startedAt = typeof item.startedAt === "number" ? item.startedAt : undefined
    const updatedAt = typeof item.updatedAt === "number" ? item.updatedAt : undefined
    if (!id || !kind || !status || !conversationID || !sessionID || !title) continue
    if (startedAt === undefined || updatedAt === undefined) continue
    out.push({
      id,
      kind,
      conversationID,
      sessionID,
      title,
      status,
      startedAt,
      updatedAt,
      messageID: typeof item.messageID === "string" ? item.messageID : undefined,
      callID: typeof item.callID === "string" ? item.callID : undefined,
      parentTaskID: typeof item.parentTaskID === "string" ? item.parentTaskID : undefined,
      childSessionID: typeof item.childSessionID === "string" ? item.childSessionID : undefined,
      backgroundTaskID: typeof item.backgroundTaskID === "string" ? item.backgroundTaskID : undefined,
      subagent: typeof item.subagent === "string" ? item.subagent : undefined,
      category: typeof item.category === "string" ? item.category : undefined,
      model: isPlainObject(item.model) && typeof item.model.providerID === "string" && typeof item.model.modelID === "string"
        ? { providerID: item.model.providerID, modelID: item.model.modelID }
        : undefined,
      runInBackground: typeof item.runInBackground === "boolean" ? item.runInBackground : undefined,
      error: typeof item.error === "string" ? item.error : undefined,
    })
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStatus(value: unknown): value is AgentTaskStatus {
  return (
    value === "running" ||
    value === "waiting" ||
    value === "completed" ||
    value === "error" ||
    value === "cancelled"
  )
}
