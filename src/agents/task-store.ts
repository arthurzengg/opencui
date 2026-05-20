import * as vscode from "vscode"

export const AGENT_TASKS_KEY = "opencui.agentTasks"

export type AgentTaskStatus =
  | "running"
  | "waiting"
  | "completed"
  | "error"
  | "cancelled"

export type AgentTaskKind = "main" | "subagent"

export type AgentTask = {
  id: string
  kind: AgentTaskKind
  conversationID: string
  sessionID: string
  messageID?: string
  callID?: string
  parentTaskID?: string
  title: string
  status: AgentTaskStatus
  startedAt: number
  updatedAt: number
  error?: string
}

const ACTIVE_STATUSES: ReadonlyArray<AgentTaskStatus> = ["running", "waiting"]
const ATTENTION_STATUSES: ReadonlyArray<AgentTaskStatus> = ["running", "waiting", "error"]

export function mainTaskID(conversationID: string, sessionID: string): string {
  return `main:${conversationID}:${sessionID}`
}

export function subagentTaskID(sessionID: string, callID: string): string {
  return `subagent:${sessionID}:${callID}`
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

  async upsert(task: AgentTask): Promise<void> {
    const idx = this.tasks.findIndex((t) => t.id === task.id)
    if (idx >= 0) {
      const existing = this.tasks[idx]!
      // Once a task is in a terminal state, ignore later "running"-style
      // upserts so duplicated SSE events can't resurrect a finished task.
      if (isTerminal(existing.status) && !isTerminal(task.status)) return
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
    if (isTerminal(existing.status) && patch.status && !isTerminal(patch.status)) return
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
   * Mark every still-running/waiting task for a session as completed. Used
   * when the session truly settles and no continuation is expected.
   */
  async markSessionIdle(sessionID: string, now: number = Date.now()): Promise<void> {
    let changed = false
    this.tasks = this.tasks.map((task) => {
      if (task.sessionID !== sessionID) return task
      if (!ACTIVE_STATUSES.includes(task.status)) return task
      changed = true
      return { ...task, status: "completed", updatedAt: now }
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

function sameTask(a: AgentTask, b: AgentTask): boolean {
  return (
    a.status === b.status &&
    a.title === b.title &&
    a.error === b.error &&
    a.messageID === b.messageID &&
    a.callID === b.callID &&
    a.parentTaskID === b.parentTaskID &&
    a.kind === b.kind &&
    a.conversationID === b.conversationID &&
    a.sessionID === b.sessionID &&
    a.startedAt === b.startedAt &&
    a.updatedAt === b.updatedAt
  )
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
