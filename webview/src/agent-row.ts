import type { AgentsTaskInfo, ToolUpdate } from "./protocol"

// What a subagent's row shows, derived from the call that started it and
// from its live task (#796). Kept apart from the component so the rules can
// be tested on recorded shapes.

/** The calls that start a subagent. The host's SUBAGENT_TOOLS, which a test pins this to. */
export const AGENT_TOOLS: ReadonlySet<string> = new Set([
  "task",
  "Task",
  "task_tool",
  "delegate_task",
  "call_omo_agent",
  "background_task",
  "subagent",
])

export function isAgentTool(tool: string): boolean {
  return AGENT_TOOLS.has(tool)
}

export type AgentState = "working" | "waiting" | "done" | "stopped" | "cancelled" | "failed"

/**
 * A call the server closed because something was stopped, not because it
 * failed. Recorded from 1.18.30: `status: "error"`, `error: "Tool execution
 * aborted"`, `metadata: { interrupted: true }`.
 */
export function wasInterrupted(update: Pick<ToolUpdate, "status" | "error" | "metadata">): boolean {
  if (update.status !== "error") return false
  return update.metadata?.interrupted === true || /^tool execution aborted$/i.test(update.error?.trim() ?? "")
}

/** `live`: the message is still being written. `stopped`: the user stopped it. */
export type TurnState = { live: boolean; stopped: boolean }

export function agentState(update: ToolUpdate, task: AgentsTaskInfo | undefined, turn: TurnState): AgentState {
  if (task?.status === "waiting") return "waiting"
  if (task?.status === "error") return "failed"
  if (update.status === "error") {
    if (!wasInterrupted(update)) return "failed"
    // The same closure serves a turn the user stopped and an agent the main one dropped.
    return turn.stopped ? "stopped" : "cancelled"
  }
  // A task still running outlives a call that has returned: an agent sent to the background.
  if (task?.status === "running") return "working"
  if (update.status === "completed") return "done"
  // A call nothing closed: working while the message is live, and stopped
  // once it is not, since a stop drops the updates still in flight.
  return turn.live ? "working" : "stopped"
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

/** What the agent was asked to do. */
export function agentTask(update: ToolUpdate): string {
  return text(update.input?.description) ?? text(update.title) ?? "Subagent"
}

/**
 * The agent's kind: what the call asked for (`subagent_type` on 1.x, `agent`
 * on 2.x), what the server resolved, what the child's own calls carry, or
 * the category it was routed by when no kind was named.
 */
export function agentKind(update: ToolUpdate | undefined, fallback?: string): string | undefined {
  return (
    text(update?.input?.subagent_type) ??
    text(update?.input?.agent) ??
    text(update?.metadata?.agent) ??
    text(fallback) ??
    text(update?.input?.category)
  )
}

/** The model the agent ran on: the call's metadata once it has returned, the live task before that. */
export function agentModel(update: ToolUpdate | undefined, task: AgentsTaskInfo | undefined): string | undefined {
  const model = update?.metadata?.model as { providerID?: unknown; modelID?: unknown } | undefined
  const providerID = text(model?.providerID) ?? task?.model?.providerID
  const modelID = text(model?.modelID) ?? task?.model?.modelID
  return providerID && modelID ? `${providerID}/${modelID}` : undefined
}

/** The live task of the agent a call started: by the call, or by the child session once its own calls arrive. */
export function findAgentTask(tasks: AgentsTaskInfo[], callID: string | undefined, sessionID: string | undefined): AgentsTaskInfo | undefined {
  return (
    (callID ? tasks.find((task) => task.callID === callID) : undefined) ??
    (sessionID ? tasks.find((task) => task.id === `subagent:child:${sessionID}`) : undefined)
  )
}

/**
 * How long the agent took, read from its call. A call that sent the agent to
 * the background returns at once ("Background task launched"), so its own
 * time says nothing about the agent's and none is shown.
 */
export function callDuration(update: ToolUpdate | undefined): number | undefined {
  if (update?.input?.run_in_background === true) return undefined
  const time = update?.time
  return time && time.end !== undefined && time.end >= time.start ? time.end - time.start : undefined
}

/** "34s", "1m 12s", "1h 04m": to the second under an hour, where a running agent is watched. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** How many subagents are at work or waiting, for the head of a folded live block. */
export function agentsNote(tasks: AgentsTaskInfo[]): { text: string; waiting: boolean } | undefined {
  const waiting = tasks.filter((task) => task.status === "waiting").length
  if (waiting) return { text: `${waiting} ${waiting === 1 ? "agent needs" : "agents need"} approval`, waiting: true }
  const working = tasks.filter((task) => task.status === "running").length
  return working ? { text: `${working} ${working === 1 ? "agent" : "agents"} working`, waiting: false } : undefined
}
