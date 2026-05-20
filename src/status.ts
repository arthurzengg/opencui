import * as vscode from "vscode"
import type { Preferences, Selection } from "./preferences"
import type { AgentTask, AgentTaskStore } from "./agents/task-store"

export type Status = "starting" | "ready" | "error" | "stopped"

const BREATHE_INTERVAL_MS = 80
const BREATHE_CYCLE_MS = 1800
const RUNNING_COLOR = "#7ee787" // light green; reads well on both light & dark themes
const ATTENTION_COLOR = new vscode.ThemeColor("statusBarItem.warningForeground")

export class StatusBar {
  private health: vscode.StatusBarItem
  private agent: vscode.StatusBarItem
  /** Hidden-by-default runtime indicator. See docs/agents-status-bar.md. */
  private agents: vscode.StatusBarItem
  private breatheTimer?: ReturnType<typeof setInterval>
  private breathePhase = 0
  private taskStoreUnsub?: vscode.Disposable

  constructor(
    context: vscode.ExtensionContext,
    private prefs: Preferences,
    private taskStore?: AgentTaskStore,
  ) {
    this.health = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.health.command = "opencui.chat.focus"
    this.health.show()

    this.agents = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99.5)
    this.agents.text = "Agents"
    this.agents.command = "opencui.agents.open"

    this.agent = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
    this.agent.command = "opencui.selectAgent"
    this.agent.show()

    context.subscriptions.push(this.health, this.agents, this.agent, {
      dispose: () => this.dispose(),
    })
    this.set("starting")
    this.renderAgent(prefs.get())
    prefs.onChange((sel) => this.renderAgent(sel))

    if (taskStore) {
      this.taskStoreUnsub = taskStore.onDidChange((tasks) => this.renderAgents(tasks))
      this.renderAgents(taskStore.list())
    }
  }

  set(status: Status, detail?: string) {
    const icons: Record<Status, string> = {
      starting: "$(sync~spin)",
      ready: "$(sparkle)",
      error: "$(error)",
      stopped: "$(circle-slash)",
    }
    this.health.text = `${icons[status]} OpenCode Panel`
    this.health.tooltip = detail ?? `OpenCode Panel: ${status}`
  }

  private renderAgent(sel: Selection) {
    const agent = sel.agent ?? "default"
    const model =
      sel.modelProviderID && sel.modelID ? `${sel.modelProviderID}/${sel.modelID}` : "default"
    this.agent.text = `$(person) ${agent}`
    this.agent.tooltip = `Agent: ${agent}\nModel: ${model}\nClick to change agent (or run "OpenCode Panel: Select Model")`
  }

  /**
   * Visibility + breathing-color + tooltip for the runtime Agents item.
   * Driven by AgentTaskStore changes. Hidden when no task is active or
   * attention-worthy. The text is always literally `Agents`.
   */
  private renderAgents(tasks: AgentTask[]) {
    const running = tasks.filter((task) => task.status === "running")
    const waiting = tasks.filter((task) => task.status === "waiting")
    const errored = tasks.filter((task) => task.status === "error")
    const visible = running.length + waiting.length + errored.length > 0

    if (!visible) {
      this.stopBreathing()
      this.agents.color = undefined
      this.agents.tooltip = undefined
      this.agents.hide()
      return
    }

    this.agents.text = "Agents"
    this.agents.tooltip = buildAgentsTooltip(running.length, waiting.length, errored.length)
    this.agents.show()

    if (running.length > 0) {
      this.startBreathing()
    } else {
      this.stopBreathing()
      this.agents.color = ATTENTION_COLOR
    }
  }

  private startBreathing() {
    if (this.breatheTimer) return
    this.breathePhase = 0
    this.agents.color = RUNNING_COLOR
    this.breatheTimer = setInterval(() => {
      this.breathePhase = (this.breathePhase + BREATHE_INTERVAL_MS) % BREATHE_CYCLE_MS
      // Smooth two-step pulse — VS Code only accepts string colors or
      // ThemeColors, so we alternate between two hex shades rather than
      // applying alpha animation.
      const halfway = this.breathePhase < BREATHE_CYCLE_MS / 2
      this.agents.color = halfway ? RUNNING_COLOR : "#39d353"
    }, BREATHE_INTERVAL_MS)
  }

  private stopBreathing() {
    if (this.breatheTimer) {
      clearInterval(this.breatheTimer)
      this.breatheTimer = undefined
    }
  }

  private dispose() {
    this.stopBreathing()
    this.taskStoreUnsub?.dispose()
  }
}

export function buildAgentsTooltip(running: number, waiting: number, errored: number): string {
  const lines: string[] = []
  if (running > 0) lines.push(`${running} agent${running === 1 ? "" : "s"} running`)
  if (waiting > 0) lines.push(`${waiting} waiting for input`)
  if (errored > 0) lines.push(`${errored} with errors`)
  lines.push("Click to view")
  return lines.join("\n")
}
