import type { ToolUpdate } from "../chat/stream"
import type { AgentsStatusInfo, AgentsTaskInfo } from "../protocol"
import {
  ATTENTION_STATUSES,
  isAttentionStatus,
  type AgentTask,
  type AttentionStatus,
} from "./task-store"

/**
 * Tool names that represent dispatching a subagent. Mirrors
 * `TASK_TOOLS` + `TARGET_TOOLS2` from oh-my-opencode's source plus the
 * omo background-task and delegate-task families:
 *   - `task` / `Task` / `task_tool` — opencode's built-in task tool (and
 *     omo's `delegateTask` which is registered under the name `task`).
 *   - `delegate_task` — defensive: if a future omo version re-registers
 *     this with its lowercase name we still catch it.
 *   - `call_omo_agent` — omo's parallel subagent dispatcher used by the
 *     deep-agent stack (Hephaestus / Sisyphus / Prometheus).
 *   - `background_task` — omo's pure background dispatcher, used by
 *     Hephaestus prompts for fire-and-forget worker tasks.
 * `SubagentTracker.isSubagentDispatchTool` consults this same set.
 */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  "task",
  "Task",
  "task_tool",
  "delegate_task",
  "call_omo_agent",
  "background_task",
])

export function isSubagentTool(toolName: string): boolean {
  return SUBAGENT_TOOLS.has(toolName)
}

export function summarizeAgentTasks(
  tasks: AgentTask[],
  conversationID?: string,
): AgentsStatusInfo {
  const scoped = conversationID
    ? tasks.filter((task) => task.conversationID === conversationID)
    : tasks

  // The popover shows ONLY currently-active work — main tasks and any
  // subagents whose status is in ATTENTION_STATUSES. `completed` and
  // `cancelled` rows are dropped so the popover reflects "what's happening
  // right now," not a per-chat history. A second user prompt gets its own
  // main row (see mainTaskID's per-turn keying); the prior turn's row is
  // settled and filtered out.
  const counts: Record<AttentionStatus, number> = Object.fromEntries(
    ATTENTION_STATUSES.map((status) => [status, 0]),
  ) as Record<AttentionStatus, number>
  const items: AgentsTaskInfo[] = []
  for (const task of scoped) {
    if (!isAttentionStatus(task.status)) continue
    counts[task.status] += 1
    items.push({
      id: task.id,
      kind: task.kind,
      title: task.title,
      status: task.status,
      error: task.error,
      startedAt: task.startedAt,
      updatedAt: task.updatedAt,
      subagent: task.kind === "subagent" ? task.subagent : undefined,
      category: task.kind === "subagent" ? task.category : undefined,
      model: task.kind === "subagent" ? task.model : undefined,
    })
  }
  // Stable order: main tasks first (the user's prompt anchor), then
  // subagents by startedAt asc. Within each kind, chronological order
  // is what makes "scrolling back through the turn" make sense.
  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "main" ? -1 : 1
    return a.startedAt - b.startedAt
  })
  return {
    running: counts.running,
    waiting: counts.waiting,
    error: counts.error,
    total: counts.running + counts.waiting + counts.error,
    tasks: items,
  }
}

export function taskTitleFromUpdate(update: ToolUpdate): string {
  const input = update.input
  if (input && typeof input === "object") {
    const description = (input as Record<string, unknown>).description
    if (typeof description === "string" && description.trim()) return description.trim()
  }
  if (update.title && update.title.trim()) return update.title.trim()
  return "Background agent"
}
