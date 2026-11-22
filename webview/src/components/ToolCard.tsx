import { useContext, useEffect, useState, type ReactNode } from "react"
import type { ReviewChangeActor, Todo, ToolStatus, ToolUpdate } from "../protocol"
import { basename, isRecord, patchKind } from "../review-extract"
import { vscode } from "../vscode"
import {
  agentKind,
  agentModel,
  agentState,
  agentTask,
  callDuration,
  findAgentTask,
  formatDuration,
  isAgentTool,
  wasInterrupted,
  type AgentState,
} from "../agent-row"
import { AgentTasksContext, TurnContext } from "../trace-context"
import { formatAgent, formatModel, subagentLabel } from "./StatusBar"

/**
 * Grace period before a running row starts showing elapsed time. Most tools
 * finish well under this; ticking a counter on every quick read/edit would
 * add churn without information. Past it, the counter is what distinguishes
 * a slow tool from a hung one (#561).
 */
const ELAPSED_GRACE_MS = 2000

/**
 * Live elapsed time for a running tool row, or null while the row is not
 * running or still inside the grace period. The wire ToolUpdate carries no
 * timing, so the clock starts when the row is first observed in `running`
 * status — the SSE update lands as the tool starts, so this tracks the real
 * start closely. `pending` (e.g. awaiting a permission decision) deliberately
 * does not count as running time.
 */
function useRunningElapsed(running: boolean): string | null {
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  useEffect(() => {
    if (!running) {
      setElapsedMs(null)
      return
    }
    const started = Date.now()
    setElapsedMs(0)
    const handle = window.setInterval(() => setElapsedMs(Date.now() - started), 1000)
    return () => window.clearInterval(handle)
  }, [running])
  if (elapsedMs === null || elapsedMs < ELAPSED_GRACE_MS) return null
  return formatElapsed(elapsedMs)
}

/** A running call's time at a glance: whole minutes past the first, since nobody watches a tool by the second. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes - hours * 60
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`
}

type FileAction = "read" | "created" | "updated" | "deleted" | "moved"

type FileOp = {
  path: string
  action: FileAction
  range?: string
  additions?: number
  deletions?: number
  status: ToolStatus
  errorText?: string
  reviewable: boolean
}

type OtherOp = {
  key: string
  /** Codicon name for the row's leading icon. */
  icon: string
  action: string
  detail?: string
  status: ToolStatus
  errorText?: string
  /** The call itself, when it started a subagent: the row is an agent's, not a tool's. */
  agent?: ToolUpdate
  /** Closed by a stop, not by a failure. */
  stopped?: boolean
}

type PatchInput = { files: string[]; diff?: string }
export type TraceTool = { update: ToolUpdate; actor?: ReviewChangeActor }
export type TracePatch = PatchInput & { actor?: ReviewChangeActor }
type Trace = ReturnType<typeof buildTrace>
type SubagentWork = { key: string; actor: ReviewChangeActor; updates: ToolUpdate[]; patches: PatchInput[] }

export function ToolTrace({
  tools,
  patches = [],
  onReviewFile,
}: {
  tools: TraceTool[]
  patches?: TracePatch[]
  onReviewFile?: (path: string) => void
}) {
  const work = splitSubagentWork(tools, patches)
  const trace = buildTrace(work.updates, work.patches)
  const rows = new Set(trace.others.map((op) => op.key))
  const nested = new Map<string, SubagentWork>()
  const loose: SubagentWork[] = []
  for (const group of work.groups) {
    if (group.actor.callID && rows.has(group.actor.callID)) nested.set(group.actor.callID, group)
    else loose.push(group)
  }
  if (!hasRows(trace) && !loose.length) return null

  return (
    <div className="trace">
      <TraceRows trace={trace} nested={nested} onReviewFile={onReviewFile} />
      {loose.map((group) => (
        <AgentRow key={group.key} work={group} onReviewFile={onReviewFile} />
      ))}
    </div>
  )
}

function hasRows(trace: Trace) {
  return trace.edits.length > 0 || trace.reads.length > 0 || trace.others.length > 0 || !!trace.todos
}

function TraceRows({
  trace,
  nested,
  onReviewFile,
}: {
  trace: Trace
  nested?: Map<string, SubagentWork>
  onReviewFile?: (path: string) => void
}) {
  return (
    <>
      {trace.edits.length > 0 && (
        <div className="trace-edits">
          {trace.edits.map((op) => (
            <EditCard key={op.path} op={op} onReviewFile={onReviewFile} />
          ))}
        </div>
      )}
      {trace.reads.length > 0 && <ReadsLine reads={trace.reads} />}
      {trace.todos && <TodoBlock todos={trace.todos} />}
      {trace.others.length > 0 && (
        <div className="trace-others">
          {trace.others.map((op) => {
            const work = nested?.get(op.key)
            if (!op.agent && !work) return <OtherRow key={op.key} op={op} />
            return <AgentRow key={op.key} op={op} work={work} onReviewFile={onReviewFile} />
          })}
        </div>
      )}
    </>
  )
}

/** One clock for a row that is timing something; it ticks only while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const handle = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(handle)
  }, [active])
  return now
}

const AGENT_GLYPH: Record<Exclude<AgentState, "working" | "waiting" | "stopped">, string> = {
  done: "check",
  cancelled: "dash",
  failed: "error",
}
const AGENT_STATE_LABEL: Record<AgentState, string> = {
  working: "working",
  waiting: "needs approval",
  done: "done",
  stopped: "stopped",
  cancelled: "cancelled",
  failed: "failed",
}

/**
 * A subagent, as one row where it was started (#796): its task, who has it,
 * its latest step, and the time. Its own calls stay folded until the row is
 * clicked. A group the host could not tie to a call here (the child surfaced
 * before its row, or that row sits in an earlier cluster) has no task to
 * show and names the agent instead.
 */
function AgentRow({
  op,
  work,
  onReviewFile,
}: {
  op?: OtherOp
  work?: SubagentWork
  onReviewFile?: (path: string) => void
}) {
  const tasks = useContext(AgentTasksContext)
  const turn = useContext(TurnContext)
  const [open, setOpen] = useState(false)
  const update = op?.agent
  const task = findAgentTask(tasks, op?.key, work?.actor.sessionID)
  const state: AgentState = update
    ? agentState(update, task, turn)
    : task?.status === "waiting"
      ? "waiting"
      : turn.live
        ? "working"
        : "done"
  const now = useNow(state === "working")

  const kind = agentKind(update, work?.actor.subagent ?? task?.subagent)
  const who = kind ? formatAgent(kind) : undefined
  const title = update ? agentTask(update) : subagentLabel(work?.actor.subagent)
  const started = update?.time?.start ?? task?.startedAt
  const took = state === "working" ? (started !== undefined ? Math.max(0, now - started) : undefined) : callDuration(update)
  const time = took !== undefined ? formatDuration(took) : undefined

  const steps = work ? buildTrace(work.updates, work.patches) : undefined
  const canOpen = Boolean(steps && hasRows(steps))
  const count = work?.updates.length ?? 0
  const latest = work?.updates[count - 1]
  const model = agentModel(update, task)
  const meta = [model ? formatModel(model) : undefined, count ? `${count} ${count === 1 ? "step" : "steps"}` : undefined]
    .filter(Boolean)
    .join(" · ")

  const join = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(" · ") || undefined
  let side: string | undefined
  let line: ReactNode
  if (state === "working") {
    side = time
    // The update that arrives is a finished call, so the line says what the agent last did.
    line = join(who, latest ? stepPhrase(latest) : undefined)
  } else if (state === "waiting") {
    side = "Needs approval"
    line = join(who, "Waiting for you")
  } else if (state === "failed") {
    side = time
    line = (
      <>
        {who && `${who} · `}
        <span className="agent-row-reason">{task?.error ?? op?.errorText ?? "Failed"}</span>
      </>
    )
  } else if (state === "done") {
    side = join(who, time)
  } else {
    side = join(state === "stopped" ? "Stopped" : "Cancelled", time)
  }

  return (
    <div className={`agent-row is-${state}`}>
      <button
        type="button"
        className="agent-row-head"
        title={title}
        aria-expanded={canOpen ? open : undefined}
        aria-disabled={canOpen ? undefined : true}
        onClick={canOpen ? () => setOpen(!open) : undefined}
      >
        {state === "working" ? (
          <span className="trace-icon codicon codicon-loading codicon-modifier-spin" role="img" aria-label="working" />
        ) : state === "waiting" ? (
          <span className="trace-icon" role="img" aria-label="needs approval">
            <span className="agent-row-need" />
          </span>
        ) : state === "stopped" ? (
          // The icon font's stop glyphs are outlines, which read as an unticked box.
          <span className="trace-icon" role="img" aria-label="stopped">
            <span className="agent-row-stop" />
          </span>
        ) : (
          <span className={`trace-icon codicon codicon-${AGENT_GLYPH[state]}`} role="img" aria-label={AGENT_STATE_LABEL[state]} />
        )}
        <span className="agent-row-title">{title}</span>
        {side && <span className="agent-row-side">{side}</span>}
        {line && <span className="agent-row-line">{line}</span>}
      </button>
      {open && steps && (
        <div className="agent-row-steps">
          {meta && <div className="agent-row-meta">{meta}</div>}
          <div className="trace-subagent">
            <TraceRows trace={steps} onReviewFile={onReviewFile} />
          </div>
        </div>
      )}
    </div>
  )
}

/** A call in a few words, for the line under a working agent: the verb its row carries, then what it acted on. */
export function stepPhrase(update: ToolUpdate): string {
  const path = pickPath(update)
  if (update.tool === "read" && path) return `Read ${basename(path)}`
  if ((update.tool === "edit" || update.tool === "write") && path) return `Edited ${basename(path)}`
  const op = deriveOther(update)
  return [op.action, op.detail].filter(Boolean).join(" ")
}

/**
 * Split a cluster into the parent's own calls and one group per child
 * session, keyed by the dispatch call when the host knew it.
 */
function splitSubagentWork(tools: TraceTool[], patches: TracePatch[]) {
  const updates: ToolUpdate[] = []
  const own: PatchInput[] = []
  const groups = new Map<string, SubagentWork>()
  const groupFor = (actor: ReviewChangeActor) => {
    const key = actor.callID ?? actor.sessionID ?? "subagent"
    let group = groups.get(key)
    if (!group) {
      group = { key, actor, updates: [], patches: [] }
      groups.set(key, group)
    }
    return group
  }
  for (const tool of tools) {
    if (tool.actor?.kind === "subagent") groupFor(tool.actor).updates.push(tool.update)
    else updates.push(tool.update)
  }
  for (const patch of patches) {
    const entry = { files: patch.files, diff: patch.diff }
    if (patch.actor?.kind === "subagent") groupFor(patch.actor).patches.push(entry)
    else own.push(entry)
  }
  return { updates, patches: own, groups: [...groups.values()] }
}

function TodoBlock({ todos }: { todos: Todo[] }) {
  if (!todos.length) return null
  const completed = todos.filter((t) => t.status === "completed" || t.status === "cancelled").length
  return (
    <div className="trace-todos">
      <div className="trace-todos-head">
        <span className="trace-todos-label">Todos</span>
        <span className="trace-todos-progress">{completed}/{todos.length}</span>
      </div>
      <ul className="trace-todos-list">
        {todos.map((todo, i) => (
          <li key={i} className={`trace-todo-item status-${todo.status}`}>
            <span className="trace-todo-status" aria-label={statusLabel(todo.status)} />
            <span className="trace-todo-content">{todo.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function statusLabel(status: Todo["status"]): string {
  if (status === "completed") return "completed"
  if (status === "in_progress") return "in progress"
  if (status === "cancelled") return "cancelled"
  return "pending"
}

/**
 * A row's leading icon: what the call is at rest, a spinner while it runs.
 * The spinner is the row's only running cue until the elapsed time shows, so
 * it carries the state's name for assistive tech.
 */
function TraceIcon({ name, status }: { name: string; status: ToolStatus }) {
  if (status === "running") {
    return <span className="trace-icon codicon codicon-loading codicon-modifier-spin" role="img" aria-label="running" />
  }
  return <span className={`trace-icon codicon codicon-${status === "error" ? "error" : name}`} aria-hidden="true" />
}

const EDIT_ICONS: Record<FileAction, string> = {
  read: "eye",
  created: "new-file",
  updated: "edit",
  deleted: "trash",
  moved: "arrow-right",
}

function EditCard({ op, onReviewFile }: { op: FileOp; onReviewFile?: (path: string) => void }) {
  const elapsed = useRunningElapsed(op.status === "running")
  const click = () => {
    if (onReviewFile && op.reviewable) onReviewFile(op.path)
    else vscode.post({ type: "openFile", path: op.path })
  }
  return (
    <button className={`edit-row status-${op.status} kind-${op.action}`} onClick={click} title={op.path}>
      <TraceIcon name={EDIT_ICONS[op.action]} status={op.status} />
      <span className="edit-main">
        <span className="edit-name">{basename(op.path)}</span>
        {typeof op.additions === "number" && op.additions > 0 && <span className="edit-add">+{op.additions}</span>}
        {typeof op.deletions === "number" && op.deletions > 0 && <span className="edit-del">−{op.deletions}</span>}
        {elapsed && <span className="trace-elapsed">{elapsed}</span>}
      </span>
      {op.errorText && <span className="edit-error">{op.errorText}</span>}
    </button>
  )
}

function ReadsLine({ reads }: { reads: FileOp[] }) {
  const running = reads.some((op) => op.status === "running")
  return (
    <div className="trace-reads">
      <TraceIcon name={EDIT_ICONS.read} status={running ? "running" : "completed"} />
      <span className="trace-reads-label">Read</span>
      <div className="trace-reads-list">
        <span className="trace-reads-count">{reads.length}</span>
        {reads.map((op, i) => (
          <button
            key={op.path}
            className="trace-read-chip"
            onClick={() => vscode.post({ type: "openFile", path: op.path })}
            title={op.range ? `${op.path} (${op.range})` : op.path}
          >
            <span className="trace-read-name">{basename(op.path)}</span>
            {op.range && <span className="trace-read-range">{op.range}</span>}
            {i < reads.length - 1 && <span className="trace-read-sep">,</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

function OtherRow({ op }: { op: OtherOp }) {
  const elapsed = useRunningElapsed(op.status === "running")
  // A call a stop closed is not a failure: it keeps its own icon and says so in neutral type (#796).
  const status = op.stopped ? "stopped" : op.status
  return (
    <div className={`other-row status-${status}`} title={[op.action, op.detail].filter(Boolean).join(" ")}>
      <TraceIcon name={op.icon} status={op.stopped ? "completed" : op.status} />
      <span className="other-action">{op.action}</span>
      <span className="other-body">
        {op.detail && <span className="other-detail">{op.detail}</span>}
        {elapsed && <span className="trace-elapsed">{elapsed}</span>}
        {op.stopped ? <span className="other-stopped">Stopped</span> : op.errorText && <span className="other-error">{op.errorText}</span>}
      </span>
    </div>
  )
}

export function buildTrace(updates: ToolUpdate[], patches: PatchInput[]) {
  const fileOps = new Map<string, FileOp>()
  const others: OtherOp[] = []
  let todos: Todo[] | undefined

  for (const update of updates) {
    if (update.tool === "todowrite") {
      // Route todowrite into a dedicated todos block instead of an "Updated todos" row.
      // Successive todowrite calls within the same trace cluster overwrite each other,
      // so we always show the latest snapshot.
      const next = Array.isArray(update.input?.todos) ? (update.input.todos as Todo[]) : undefined
      if (next) todos = next
      continue
    }
    if (update.tool === "read") {
      const path = pickPath(update)
      if (!path) {
        others.push(genericOther(update))
        continue
      }
      const existing = fileOps.get(path)
      if (existing && existing.action !== "read") continue
      fileOps.set(path, {
        path,
        action: "read",
        range: lineRange(update) ?? existing?.range,
        status: mergeStatus(existing?.status, update.status),
        errorText: update.error ?? existing?.errorText,
        reviewable: false,
      })
      continue
    }
    if (update.tool === "edit") {
      const path = pickPath(update)
      if (!path) {
        others.push(genericOther(update))
        continue
      }
      const action: FileAction = update.input?.oldString === "" ? "created" : "updated"
      const stats = diffStats(update)
      mergeFileOp(fileOps, path, {
        action,
        additions: stats.additions,
        deletions: stats.deletions,
        status: update.status,
        errorText: update.error,
        reviewable: true,
      })
      continue
    }
    if (update.tool === "write") {
      const path = pickPath(update)
      if (!path) {
        others.push(genericOther(update))
        continue
      }
      const action: FileAction = update.metadata?.exists === false ? "created" : "updated"
      mergeFileOp(fileOps, path, {
        action,
        additions: writeLines(update),
        status: update.status,
        errorText: update.error,
        reviewable: true,
      })
      continue
    }
    if (update.tool === "apply_patch") {
      const files = patchFilesFromUpdate(update)
      if (!files.length) {
        others.push({
          key: update.callID,
          icon: "diff",
          action: "Applied patch",
          status: update.status,
          errorText: update.error,
        })
        continue
      }
      for (const file of files) {
        mergeFileOp(fileOps, file.path, {
          action: file.kind,
          additions: file.additions,
          deletions: file.deletions,
          status: update.status,
          errorText: update.error,
          reviewable: true,
        })
      }
      continue
    }
    others.push(deriveOther(update))
  }

  for (const patch of patches) {
    for (const entry of patch.files) {
      const match = entry.match(/^([AMD])\s+(.+)$/)
      const path = (match?.[2] ?? entry).trim()
      if (!path) continue
      if (fileOps.has(path)) continue
      const code = match?.[1]
      const action: FileAction = code === "A" ? "created" : code === "D" ? "deleted" : "updated"
      fileOps.set(path, {
        path,
        action,
        status: "completed",
        reviewable: true,
      })
    }
  }

  const interrupted = new Set(updates.filter(wasInterrupted).map((update) => update.callID))
  for (const op of others) if (interrupted.has(op.key)) op.stopped = true

  const allOps = [...fileOps.values()]
  const edits = allOps.filter((op) => op.action !== "read")
  const reads = allOps.filter((op) => op.action === "read")
  return { edits, reads, others, todos }
}

function mergeFileOp(map: Map<string, FileOp>, path: string, patch: Omit<FileOp, "path" | "range" | "reviewable"> & { reviewable: boolean }) {
  const existing = map.get(path)
  const additions = (existing?.additions ?? 0) + (patch.additions ?? 0)
  const deletions = (existing?.deletions ?? 0) + (patch.deletions ?? 0)
  const action = preferAction(existing?.action, patch.action)
  map.set(path, {
    path,
    action,
    additions: additions || undefined,
    deletions: deletions || undefined,
    status: mergeStatus(existing?.status, patch.status),
    errorText: patch.errorText ?? existing?.errorText,
    reviewable: patch.reviewable || (existing?.reviewable ?? false),
  })
}

export function preferAction(existing: FileAction | undefined, next: FileAction): FileAction {
  if (!existing) return next
  if (existing === "read") return next
  if (next === "read") return existing
  if (existing === "created" || next === "created") return "created"
  if (existing === "deleted" || next === "deleted") return "deleted"
  return next
}

export function mergeStatus(existing: ToolStatus | undefined, next: ToolStatus): ToolStatus {
  if (!existing) return next
  if (next === "error" || existing === "error") return "error"
  if (next === "running" || existing === "running") return "running"
  if (next === "pending" || existing === "pending") return "pending"
  return next
}

function deriveOther(update: ToolUpdate): OtherOp {
  if (update.tool === "grep") {
    return {
      key: update.callID,
      icon: "search",
      action: "Grepped",
      detail: stringInput(update, "pattern") ?? update.title,
      status: update.status,
      errorText: update.error,
    }
  }
  if (update.tool === "glob") {
    return {
      key: update.callID,
      icon: "search",
      action: "Searched",
      detail: stringInput(update, "pattern") ?? update.title,
      status: update.status,
      errorText: update.error,
    }
  }
  if (update.tool === "bash") {
    return {
      key: update.callID,
      icon: "terminal",
      action: "Ran",
      detail: stringInput(update, "command") ?? update.title,
      status: update.status,
      errorText: update.error,
    }
  }
  if (update.tool === "webfetch") {
    return {
      key: update.callID,
      icon: "globe",
      action: "Fetched",
      detail: stringInput(update, "url") ?? update.title,
      status: update.status,
      errorText: update.error,
    }
  }
  if (isAgentTool(update.tool)) {
    return {
      key: update.callID,
      icon: "robot",
      action: "Agent",
      detail: agentTask(update),
      status: update.status,
      errorText: update.error,
      agent: update,
    }
  }
  return genericOther(update)
}

function genericOther(update: ToolUpdate): OtherOp {
  return {
    key: update.callID,
    icon: "wrench",
    action: pastTense(update.tool),
    detail: update.title ?? stringInput(update, "description"),
    status: update.status,
    errorText: update.error,
  }
}

export function stringInput(update: ToolUpdate, key: string): string | undefined {
  const value = update.input?.[key]
  return typeof value === "string" ? value : undefined
}

export function pickPath(update: ToolUpdate): string | undefined {
  if (typeof update.input?.filePath === "string") return update.input.filePath
  if (isFileTool(update.tool) && typeof update.input?.path === "string") return update.input.path
  if (isFileTool(update.tool) && update.title) return update.title
  return undefined
}

export function patchFilesFromUpdate(update: ToolUpdate): Array<{ path: string; kind: FileAction; additions?: number; deletions?: number }> {
  const files = Array.isArray(update.metadata?.files) ? update.metadata.files : undefined
  if (files) {
    return files.flatMap((item) => {
      if (!isRecord(item) || typeof item.relativePath !== "string") return []
      return [{
        path: item.relativePath,
        kind: patchKind(item.type),
        additions: typeof item.additions === "number" ? item.additions : undefined,
        deletions: typeof item.deletions === "number" ? item.deletions : undefined,
      }]
    })
  }
  return [...(update.output ?? "").matchAll(/^[AMD]\s+(.+)$/gm)].map((match) => ({
    path: match[1] ?? "file",
    kind: match[0].startsWith("A ") ? "created" : match[0].startsWith("D ") ? "deleted" : "updated",
  }))
}

function diffStats(update: ToolUpdate): { additions?: number; deletions?: number } {
  const filediff = isRecord(update.metadata?.filediff) ? update.metadata.filediff : undefined
  return {
    additions: typeof filediff?.additions === "number" ? filediff.additions : undefined,
    deletions: typeof filediff?.deletions === "number" ? filediff.deletions : undefined,
  }
}

export function writeLines(update: ToolUpdate): number | undefined {
  const content = update.input?.content
  if (typeof content !== "string") return undefined
  if (content === "") return 0
  // A trailing newline ends the last line, it does not start another one. The
  // review card's synthesized patch counts the same way, and the two sit on
  // one screen (#746).
  const lines = content.split("\n").length
  return content.endsWith("\n") ? lines - 1 : lines
}

export function lineRange(update: ToolUpdate): string | undefined {
  const matches = [...(update.output ?? "").matchAll(/(?:^|\n)(\d+): /g)]
  if (matches.length) {
    const start = matches[0]?.[1]
    const end = matches[matches.length - 1]?.[1]
    if (start && end) return start === end ? `L${start}` : `L${start}-${end}`
  }
  const offset = typeof update.input?.offset === "number" ? update.input.offset : undefined
  const limit = typeof update.input?.limit === "number" ? update.input.limit : undefined
  if (offset && limit) return `L${offset}-${offset + limit - 1}`
  if (offset) return `L${offset}`
  return undefined
}

function isFileTool(tool: string) {
  return tool === "read" || tool === "edit" || tool === "write"
}

function pastTense(tool: string) {
  if (tool.endsWith("e")) return `${tool}d`
  return `${tool}ed`
}

export function toolHeadline(updates: ToolUpdate[]) {
  const trace = buildTrace(updates, [])
  if (trace.edits.length === 1) return `${kindWord(trace.edits[0]!.action)} ${basename(trace.edits[0]!.path)}`
  if (trace.edits.length > 1) {
    const created = trace.edits.filter((op) => op.action === "created").length
    const deleted = trace.edits.filter((op) => op.action === "deleted").length
    if (created && created === trace.edits.length) return `Created ${created} files`
    if (deleted && deleted === trace.edits.length) return `Deleted ${deleted} files`
    return `Changed ${trace.edits.length} files`
  }
  if (trace.reads.length && trace.others.length) {
    return `Explored ${count(trace.reads.length, "file")}, ${count(trace.others.length, "op")}`
  }
  if (trace.reads.length) return `Read ${trace.reads.length} ${trace.reads.length === 1 ? "file" : "files"}`
  if (trace.others.length) return `Used ${trace.others.length} ${trace.others.length === 1 ? "tool" : "tools"}`
  return `Used ${updates.length} ${updates.length === 1 ? "tool" : "tools"}`
}

function count(n: number, unit: string): string {
  return `${n} ${n === 1 ? unit : `${unit}s`}`
}

function kindWord(action: FileAction): string {
  if (action === "created") return "Created"
  if (action === "deleted") return "Deleted"
  if (action === "moved") return "Moved"
  if (action === "read") return "Read"
  return "Updated"
}
