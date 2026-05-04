import * as vscode from "vscode"
import type { ServerManager } from "./server"
import type { Preferences } from "./preferences"
import { log } from "./output"

export class Picker {
  constructor(private servers: ServerManager, private prefs: Preferences) {}

  async pickAgent() {
    try {
      const backend = await this.servers.ensure()
      const res = await backend.client.app.agents()
      if (res.error || !res.data) {
        vscode.window.showErrorMessage(`OpenCUI: failed to load agents`)
        return
      }
      const usable = res.data.filter((a) => a.mode !== "subagent")
      const items: vscode.QuickPickItem[] = [
        { label: "$(circle-slash) (default)", description: "use opencode default agent" },
        ...usable.map((a) => ({
          label: `$(person) ${a.name}`,
          description: a.description ?? "",
          detail: a.model ? `${a.model.providerID}/${a.model.modelID}` : undefined,
        })),
      ]
      const picked = await vscode.window.showQuickPick(items, { title: "Select OpenCUI agent" })
      if (!picked) return
      const name = picked.label.replace(/^\$\([^)]+\)\s*/, "")
      if (name === "(default)") {
        await this.prefs.setAgent(undefined)
        vscode.window.showInformationMessage("OpenCUI: agent reset to default")
      } else {
        await this.prefs.setAgent(name)
        vscode.window.showInformationMessage(`OpenCUI: agent → ${name}`)
      }
    } catch (e) {
      log("pickAgent failed", e)
      vscode.window.showErrorMessage(`OpenCUI: ${(e as Error).message}`)
    }
  }

  async pickModel() {
    try {
      const backend = await this.servers.ensure()
      const res = await backend.client.config.providers()
      if (res.error || !res.data) {
        vscode.window.showErrorMessage(`OpenCUI: failed to load providers`)
        return
      }
      const providers = res.data.providers ?? []
      const items: vscode.QuickPickItem[] = [
        { label: "$(circle-slash) (default)", description: "use opencode default model" },
      ]
      for (const p of providers) {
        const modelKeys = Object.keys(p.models ?? {})
        for (const m of modelKeys) {
          items.push({
            label: `$(sparkle) ${p.id}/${m}`,
            description: p.name ?? "",
          })
        }
      }
      const picked = await vscode.window.showQuickPick(items, {
        title: "Select OpenCUI model",
        matchOnDescription: true,
      })
      if (!picked) return
      const cleaned = picked.label.replace(/^\$\([^)]+\)\s*/, "")
      if (cleaned === "(default)") {
        await this.prefs.setModel(undefined, undefined)
        vscode.window.showInformationMessage("OpenCUI: model reset to default")
        return
      }
      const [providerID, ...rest] = cleaned.split("/")
      const modelID = rest.join("/")
      await this.prefs.setModel(providerID, modelID)
      vscode.window.showInformationMessage(`OpenCUI: model → ${providerID}/${modelID}`)
    } catch (e) {
      log("pickModel failed", e)
      vscode.window.showErrorMessage(`OpenCUI: ${(e as Error).message}`)
    }
  }
}
