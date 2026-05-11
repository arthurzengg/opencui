import * as vscode from "vscode"
import type { Preferences, Selection } from "./preferences"

export type Status = "starting" | "ready" | "error" | "stopped"

export class StatusBar {
  private health: vscode.StatusBarItem
  private agent: vscode.StatusBarItem

  constructor(context: vscode.ExtensionContext, private prefs: Preferences) {
    this.health = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.health.command = "opencui.chat.focus"
    this.health.show()

    this.agent = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
    this.agent.command = "opencui.selectAgent"
    this.agent.show()

    context.subscriptions.push(this.health, this.agent)
    this.set("starting")
    this.renderAgent(prefs.get())
    prefs.onChange((sel) => this.renderAgent(sel))
  }

  set(status: Status, detail?: string) {
    const icons: Record<Status, string> = {
      starting: "$(sync~spin)",
      ready: "$(sparkle)",
      error: "$(error)",
      stopped: "$(circle-slash)",
    }
    this.health.text = `${icons[status]} OpenCode CUI`
    this.health.tooltip = detail ?? `OpenCode CUI: ${status}`
  }

  private renderAgent(sel: Selection) {
    const agent = sel.agent ?? "default"
    const model =
      sel.modelProviderID && sel.modelID ? `${sel.modelProviderID}/${sel.modelID}` : "default"
    this.agent.text = `$(person) ${agent}`
    this.agent.tooltip = `Agent: ${agent}\nModel: ${model}\nClick to change agent (or run "OpenCode CUI: Select Model")`
  }
}
