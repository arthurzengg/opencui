import * as vscode from "vscode"
import type { AgentTask, AgentTaskStore } from "./task-store"

export type AgentsQuickPickItem = vscode.QuickPickItem & {
  taskID?: string
}

/**
 * Open a compact QuickPick grouping active or attention-worthy agent work
 * into `Main` and `Subagents` sections. Selecting a row focuses the
 * OpenCode Panel chat; we don't currently surface retry / abort actions.
 * Scoped to the active conversation like the Agents popover — the focus
 * action lands on the active chat, so listing other conversations' rows
 * here would point at work the click can't reach.
 */
export async function showAgentsQuickPick(
  taskStore: AgentTaskStore,
  conversationID: string,
): Promise<void> {
  const tasks = taskStore.active().filter((task) => task.conversationID === conversationID)
  if (tasks.length === 0) {
    await vscode.window.showQuickPick([{ label: "No active agents" }], {
      title: "OpenCode Panel: Agents",
    })
    return
  }
  const items = buildQuickPickItems(tasks)
  const picked = (await vscode.window.showQuickPick(items, {
    title: "OpenCode Panel: Agents",
    placeHolder: "Select an agent to focus the chat",
    matchOnDescription: true,
    matchOnDetail: true,
  })) as AgentsQuickPickItem | undefined
  if (!picked?.taskID) return
  await vscode.commands.executeCommand("opencui.chat.focus")
}

export function buildQuickPickItems(tasks: AgentTask[]): AgentsQuickPickItem[] {
  const main: AgentTask[] = []
  const sub: AgentTask[] = []
  for (const task of tasks) {
    if (task.kind === "main") main.push(task)
    else sub.push(task)
  }
  sortByStartedAt(main)
  sortByStartedAt(sub)

  const items: AgentsQuickPickItem[] = []
  if (main.length > 0) {
    items.push(separator("Main"))
    for (const task of main) items.push(toItem(task))
  }
  if (sub.length > 0) {
    items.push(separator("Subagents"))
    for (const task of sub) items.push(toItem(task))
  }
  return items
}

function separator(label: string): AgentsQuickPickItem {
  return {
    label,
    kind: vscode.QuickPickItemKind.Separator,
  }
}

function toItem(task: AgentTask): AgentsQuickPickItem {
  const elapsed = formatElapsed(task.startedAt, Date.now())
  const description = formatStatus(task) + " · " + elapsed
  const detail = task.kind === "main" ? `session ${task.sessionID}` : task.callID ? `call ${task.callID}` : undefined
  return {
    label: task.title,
    description,
    detail,
    taskID: task.id,
  }
}

function formatStatus(task: AgentTask): string {
  if (task.status === "error") return task.error ? `error: ${task.error}` : "error"
  return task.status
}

export function formatElapsed(startedAt: number, now: number): string {
  const ms = Math.max(0, now - startedAt)
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes - hours * 60
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`
}

function sortByStartedAt(tasks: AgentTask[]) {
  tasks.sort((a, b) => a.startedAt - b.startedAt)
}
