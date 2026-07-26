import { useEffect, useState } from "react"
import type { AgentsStatusInfo, AgentsTaskInfo } from "../protocol"
import { useDismissableMenu } from "../hooks/useDismissableMenu"
import { formatAgent, formatModel } from "./StatusBar"

export function AgentActivity({ status }: { status?: AgentsStatusInfo }) {
  const { toggle, ref, open } = useDismissableMenu()

  if (!status || status.total === 0) return null

  const running = status.running > 0
  const errorOnly = !running && status.error > 0
  const waitingOnly = !running && !errorOnly && status.waiting > 0
  const className =
    "agents-pill agent-activity-pill" +
    (open ? " is-open" : "") +
    (running ? " is-running" : "") +
    (errorOnly ? " is-error" : "") +
    (waitingOnly ? " is-waiting" : "")

  // total === tasks.length by construction in summarizeAgentTasks (pinned
  // by test), so past the total-0 guard above the popover always has rows.
  const tasks = status.tasks
  const main = tasks.filter((t) => t.kind === "main")
  const sub = tasks.filter((t) => t.kind === "subagent")

  return (
    <div className="agent-activity" ref={ref}>
      <button
        type="button"
        className={className}
        onClick={toggle}
        title={buildAgentsTitle(status)}
        aria-label="Open agents for this response"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="agent-activity-dot" aria-hidden="true" />
        <span className="agent-activity-name">Agents</span>
        <span className="agent-activity-summary">{activitySummary(status)}</span>
      </button>
      {open && (
        <div className="agents-popover agent-activity-popover" role="menu">
          <div className="agents-popover-title">Agents in this response</div>
          <div className="agents-popover-scroll">
            {main.length > 0 && (
              <>
                <div className="agents-popover-section">Main</div>
                {main.map((task) => (
                  <AgentsRow key={task.id} task={task} />
                ))}
              </>
            )}
            {sub.length > 0 && (
              <>
                <div className="agents-popover-section">Subagents</div>
                {sub.map((task) => (
                  <AgentsRow key={task.id} task={task} />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function AgentsRow({ task }: { task: AgentsTaskInfo }) {
  const isLive = task.status === "running" || task.status === "waiting"
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isLive) return
    const handle = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(handle)
  }, [isLive])

  const elapsedMs = isLive ? now - task.startedAt : task.updatedAt - task.startedAt
  const elapsed = formatElapsed(elapsedMs)
  const statusText = task.status === "error" && task.error
    ? `error · ${task.error}`
    : task.status
  const subagentLabel = task.subagent ? formatAgent(task.subagent) : undefined
  const modelLabel = task.model ? formatModel(`${task.model.providerID}/${task.model.modelID}`) : undefined
  const categoryLabel = task.category && task.category !== task.subagent ? task.category : undefined
  const detailParts = [
    categoryLabel ? `category: ${categoryLabel}` : undefined,
    subagentLabel,
    modelLabel,
  ].filter((part): part is string => Boolean(part))
  const detail = detailParts.length > 0 ? detailParts.join(" · ") : undefined
  const tooltip = [task.title, statusText, elapsed, detail].filter(Boolean).join(" · ")
  return (
    <div className={`agents-row agents-row-${task.status}`} title={tooltip}>
      <span className="agents-row-title">{task.title}</span>
      <span className="agents-row-meta">{statusText} · {elapsed}</span>
      {detail && <span className="agents-row-detail">{detail}</span>}
    </div>
  )
}

// Both helpers render only behind the total-0 guard, and total is the sum
// of running + waiting + error — at least one count is always non-zero.
function activitySummary(status: AgentsStatusInfo): string {
  if (status.running > 0) return `${status.running} running`
  if (status.waiting > 0) return `${status.waiting} waiting`
  return `${status.error} error${status.error === 1 ? "" : "s"}`
}

function buildAgentsTitle(status: AgentsStatusInfo): string {
  const lines: string[] = []
  if (status.running > 0)
    lines.push(`${status.running} agent${status.running === 1 ? "" : "s"} running`)
  if (status.waiting > 0) lines.push(`${status.waiting} waiting for input`)
  if (status.error > 0) lines.push(`${status.error} with errors`)
  lines.push("Click to view")
  return lines.join("\n")
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
