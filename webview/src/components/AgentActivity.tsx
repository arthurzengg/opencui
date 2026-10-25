import { useEffect, useRef, useState } from "react"
import type { AgentsStatusInfo, AgentsTaskInfo } from "../protocol"
import type { AgentActivityResult, AgentActivityStreamEvent } from "../hooks/useChatState"
import { subscribeAgentActivity } from "../hooks/useChatState"
import { useLivePhase } from "../hooks/useLivePhase"
import { formatAgent, formatModel } from "./StatusBar"
import { Markdown } from "./Markdown"

/**
 * Same grace idea as ToolCard's ELAPSED_GRACE_MS: don't flag a running
 * task until the staleness is clearly past normal churn. Measured against
 * `updatedAt`, which the host refreshes on status transitions — a running
 * row whose `updatedAt` has gone silent this long gets a "no updates
 * recently" hint in the detail view and a stuck class on the badge.
 * ponytail: host currently skips same-status refreshes while a row stays
 * running (subagent-tracker busy handler), so long healthy runs can trip
 * this — shrink the grace or ask the host lane for an updatedAt heartbeat
 * once the activity feed lands.
 */
const STUCK_GRACE_MS = 60_000

/**
 * ponytail: live buffer is unbounded per subscription except for this cap —
 * a chatty subagent's stdout would otherwise grow without limit while the
 * detail view stays open; drop oldest past the limit.
 */
const LIVE_LINE_LIMIT = 1000

export function AgentActivity({
  status,
  entering,
  requestActivity,
}: {
  status?: AgentsStatusInfo
  entering?: boolean
  requestActivity?: (taskID: string) => Promise<AgentActivityResult>
}) {
  const [selectedId, setSelectedId] = useState<string>()
  const lastChildSessionIdRef = useRef<string>()

  const selectedTask = status?.tasks.find((task) => task.id === selectedId)
  if (selectedTask?.childSessionID) {
    lastChildSessionIdRef.current = selectedTask.childSessionID
  } else if (!selectedId) {
    lastChildSessionIdRef.current = undefined
  }

  // Task disappearance (agentsStatus prune) while its detail is open:
  // clear the selection so the detail unmounts → subscribe cleanup posts
  // agentActivityUnsubscribe. If the task was promoted to childSessionID identity,
  // update selectedId so the view stays open. Hooks stay above the early return.
  useEffect(() => {
    if (!selectedId || !status) return
    const matching = status.tasks.find((task) => task.id === selectedId)
    if (matching) return
    if (lastChildSessionIdRef.current) {
      const promoted = status.tasks.find((task) => task.childSessionID === lastChildSessionIdRef.current)
      if (promoted) {
        setSelectedId(promoted.id)
        return
      }
    }
    setSelectedId(undefined)
  }, [selectedId, status])

  if (!status || status.total === 0) return null

  const tasks = status.tasks
  const selected = selectedId
    ? tasks.find(
        (task) =>
          task.id === selectedId ||
          (Boolean(lastChildSessionIdRef.current) && task.childSessionID === lastChildSessionIdRef.current),
      )
    : undefined

  return (
    <div
      className={"agent-activity" + (entering ? " is-entering" : "")}
      role="group"
      aria-label="Agents for this response"
    >
      {selected ? (
        <AgentDetail task={selected} requestActivity={requestActivity} onBack={() => setSelectedId(undefined)} />
      ) : (
        tasks.map((task) => (
          <AgentBadge key={task.id} task={task} onOpen={() => setSelectedId(task.id)} />
        ))
      )}
    </div>
  )
}

/** One badge per active agent: role name + status dot + optional tool count + short elapsed. */
function AgentBadge({ task, onOpen }: { task: AgentsTaskInfo; onOpen: () => void }) {
  const isLive = task.status === "running" || task.status === "waiting"
  const now = useTickingNow(isLive)
  const elapsed = formatElapsed(isLive ? now - task.startedAt : task.updatedAt - task.startedAt)
  const stuck = task.status === "running" && now - task.updatedAt > STUCK_GRACE_MS
  const running = task.status === "running"
  const phase = useLivePhase(running)
  const label = badgeLabel(task)
  const statusText = task.status === "error" && task.error
    ? `error · ${task.error}`
    : task.status
  const toolsText = task.toolCount && task.toolCount > 0
    ? `${task.toolCount} ${task.toolCount === 1 ? "tool" : "tools"}`
    : undefined
  const tooltip = [task.title, statusText, toolsText, elapsed, stuck ? "no updates recently" : undefined]
    .filter(Boolean)
    .join(" · ")
  return (
    <button
      type="button"
      className={`agents-badge agents-badge-${task.status}${stuck ? " is-stuck" : ""}`}
      onClick={onOpen}
      title={tooltip}
      aria-label={`Open ${label} activity`}
    >
      <span className={`agent-activity-dot${running ? " live-breathe" : ""}`} style={phase} aria-hidden="true" />
      <span className="agents-badge-name">{label}</span>
      {toolsText && <span className="agents-badge-tools">{toolsText}</span>}
      <span className="agents-badge-elapsed">{elapsed}</span>
    </button>
  )
}

/** Role name: main agent reads "Main"; subagent slug pretty-printed via formatAgent. */
function badgeLabel(task: AgentsTaskInfo): string {
  if (task.kind === "main") return "Main"
  if (task.subagent) return formatAgent(task.subagent)
  return "Agent"
}

function AgentDetail({
  task,
  requestActivity,
  onBack,
}: {
  task: AgentsTaskInfo
  requestActivity?: (taskID: string) => Promise<AgentActivityResult>
  onBack: () => void
}) {
  const [result, setResult] = useState<AgentActivityResult | undefined>(undefined)
  const [live, setLive] = useState<AgentActivityStreamEvent[]>([])
  const feedRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const isLive = task.status === "running" || task.status === "waiting"
  const now = useTickingNow(isLive)
  const elapsedMs = isLive ? now - task.startedAt : task.updatedAt - task.startedAt
  const statusText = task.status === "error" && task.error
    ? `error · ${task.error}`
    : task.status
  const stuck = task.status === "running" && now - task.updatedAt > STUCK_GRACE_MS

  // Escape key returns to badge list.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        onBack()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onBack])

  const isMain = task.kind === "main"

  // Backlog: one-shot request/response for what already happened. Re-evaluates
  // when childSessionID lands to resolve the race condition where a task is clicked
  // before opencode surfaces its child session identity.
  useEffect(() => {
    if (!requestActivity || isMain) return
    let active = true
    setResult(undefined)
    requestActivity(task.id).then((response) => {
      if (active) setResult(response)
    })
    return () => {
      active = false
    }
  }, [requestActivity, task.id, task.childSessionID, isMain])

  // Live tail: subscribe on open; cleanup posts unsubscribe (Back click or
  // task-disappearance unmount — both funnel through this teardown).
  // Consecutive text events are coalesced so streaming tokens flow naturally.
  useEffect(() => {
    if (isMain) return
    const off = subscribeAgentActivity(task.id, (event) => {
      setLive((prev) => {
        if (event.kind === "text" && prev.length > 0 && prev[prev.length - 1].kind === "text") {
          const last = prev[prev.length - 1] as { kind: "text"; text: string }
          const updated: AgentActivityStreamEvent = {
            kind: "text",
            text: last.text + event.text,
          }
          return [...prev.slice(0, -1), updated]
        }
        return prev.length >= LIVE_LINE_LIMIT ? [...prev.slice(1), event] : [...prev, event]
      })
    })
    return off
  }, [task.id, isMain])

  // Stick to bottom while the reader is at (or near) the bottom; a scroll-up
  // disengages until they return. Same idea as the chat's stick-to-bottom.
  const handleFeedScroll = () => {
    const el = feedRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 16
  }
  useEffect(() => {
    const el = feedRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  })

  const loading = !isMain && requestActivity !== undefined && result === undefined
  const errorText = isMain
    ? undefined
    : requestActivity === undefined
      ? "Activity unavailable"
      : result && !result.ok
        ? (result.error ? result.error : "Activity unavailable")
        : undefined
  const messages = result && result.ok && result.messages ? result.messages : undefined
  const empty = !isMain && !loading && !errorText && !messages?.length && live.length === 0

  return (
    <div className="agents-detail">
      <button type="button" className="agents-detail-back" onClick={onBack} aria-label="Back">
        Back
      </button>
      <div className="agents-detail-title">{task.title}</div>
      <div className="agents-detail-meta">
        <span className={`agents-detail-status agents-detail-status-${task.status}`}>{statusText}</span>
        <span> · {formatElapsed(elapsedMs)}</span>
        {stuck && <span className="agents-detail-stuck"> · no updates recently</span>}
      </div>
      <div className="agents-detail-grid">
        <div className="agents-detail-grid-row">
          <span className="agents-detail-key">Agent</span>
          <span className="agents-detail-val">{task.subagent ? task.subagent : "main"}</span>
        </div>
        {task.model && (
          <div className="agents-detail-grid-row">
            <span className="agents-detail-key">Model</span>
            <span className="agents-detail-val">{formatModel(`${task.model.providerID}/${task.model.modelID}`)}</span>
          </div>
        )}
        {task.category && task.category !== task.subagent && (
          <div className="agents-detail-grid-row">
            <span className="agents-detail-key">Category</span>
            <span className="agents-detail-val">{task.category}</span>
          </div>
        )}
      </div>
      <div className="agents-detail-feed" ref={feedRef} onScroll={handleFeedScroll}>
        {isMain && <div className="agents-detail-note">Main session activity is displayed in the chat transcript above</div>}
        {loading && <div className="agents-detail-note" role="status">Loading activity…</div>}
        {errorText && <div className="agents-detail-error">{errorText}</div>}
        {empty && <div className="agents-detail-note">No activity recorded</div>}
        {messages?.map((message, i) => (
          <div
            key={i}
            className={`agents-feed-row agents-feed-${message.role === "user" || message.role === "assistant" ? message.role : "other"}`}
          >
            <span className="agents-feed-role">{message.role}</span>
            {message.text && (
              <div className="agents-feed-text">
                <Markdown text={message.text} />
              </div>
            )}
            {message.tools && message.tools.length > 0 && (
              <div className="agents-feed-tools">
                {message.tools.map((tool, idx) => (
                  <span key={idx} className="agents-feed-tool-pill">
                    tool {tool}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {live.map((event, i) => (
          <div key={`live-${i}`} className={`agents-live-line agents-live-${event.kind}`}>
            {formatLiveLine(event)}
          </div>
        ))}
      </div>
    </div>
  )
}

export function formatLiveToolInput(tool: string, rawInput?: string): string {
  if (!rawInput) return `tool ${tool}`
  try {
    const parsed = JSON.parse(rawInput)
    if (typeof parsed === "object" && parsed !== null) {
      if (tool === "bash" && typeof parsed.command === "string") {
        return `$ ${parsed.command}`
      }
      const path = parsed.filePath ?? parsed.path
      if (typeof path === "string") {
        return `${tool} ${path}`
      }
      const pattern = parsed.pattern ?? parsed.query
      if (typeof pattern === "string") {
        return `${tool} ${pattern}`
      }
    }
  } catch {
    // not JSON or truncated string
  }
  return `tool ${tool} ${rawInput}`
}

function formatLiveLine(event: AgentActivityStreamEvent): string {
  if (event.kind === "text") return event.text
  if (event.kind === "tool") return formatLiveToolInput(event.tool, event.input)
  if (event.kind === "toolResult") return event.output ? `✓ ${event.tool} ${event.output}` : `✓ ${event.tool}`
  if (event.kind === "status") return `status ${event.status}`
  return "stream ended"
}

/** Wall-clock ticker for live badges; frozen (returns mount time) when inactive. */
function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const handle = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(handle)
  }, [active])
  return now
}

/**
 * Every prompt records a Main row, so total is never 0 during a reply. The
 * surface is for subagent work (#680), and settled rows never reach the wire,
 * so any subagent row here is running, waiting, or in error.
 */
export function hasSubagentWork(status?: AgentsStatusInfo): boolean {
  return !!status && status.tasks.some((task) => task.kind === "subagent")
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes - hours * 60
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`
}
