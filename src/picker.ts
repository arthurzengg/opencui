import * as vscode from "vscode"
import type { ServerManager } from "./server"
import type { Preferences } from "./preferences"
import { log } from "./output"

/**
 * opencode ships a few internal agents the user is not meant to pick from a UI:
 *   - `compaction` — squashes old turns into a summary when the context fills.
 *   - `summary`    — generates conversation summaries on demand.
 *   - `title`      — generates the session title from the first prompt.
 * They show up in `client.app.agents()` alongside primary/sub agents, so we
 * filter them out by name. Match case-insensitively because opencode's
 * naming may vary across versions.
 */
const INTERNAL_AGENT_NAMES = new Set(["compaction", "summary", "title"])

export function isUserSelectableAgent(agent: { name?: string; mode?: string }): boolean {
  if (agent.mode === "subagent") return false
  const name = (agent.name ?? "").toLowerCase()
  if (INTERNAL_AGENT_NAMES.has(name)) return false
  return true
}

export class Picker {
  constructor(private servers: ServerManager, private prefs: Preferences) {}

  async pickAgent() {
    try {
      const backend = await this.servers.ensure()
      const res = await backend.client.app.agents()
      if (res.error || !res.data) {
        vscode.window.showErrorMessage(`OpenCode CUI: failed to load agents`)
        return
      }
      const usable = res.data.filter(isUserSelectableAgent)
      const items: vscode.QuickPickItem[] = [
        { label: "$(circle-slash) (default)", description: "use opencode default agent" },
        ...usable.map((a) => ({
          label: `$(person) ${a.name}`,
          description: a.description ?? "",
          detail: a.model ? `${a.model.providerID}/${a.model.modelID}` : undefined,
        })),
      ]
      const picked = await vscode.window.showQuickPick(items, { title: "Select OpenCode CUI agent" })
      if (!picked) return
      const name = picked.label.replace(/^\$\([^)]+\)\s*/, "")
      if (name === "(default)") {
        await this.prefs.setAgent(undefined)
        vscode.window.showInformationMessage("OpenCode CUI: agent reset to default")
      } else {
        await this.prefs.setAgent(name)
        vscode.window.showInformationMessage(`OpenCode CUI: agent → ${name}`)
      }
    } catch (e) {
      log("pickAgent failed", e)
      vscode.window.showErrorMessage(`OpenCode CUI: ${(e as Error).message}`)
    }
  }

  async pickModel() {
    try {
      const backend = await this.servers.ensure()
      const res = await backend.client.config.providers()
      if (res.error || !res.data) {
        vscode.window.showErrorMessage(`OpenCode CUI: failed to load providers`)
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
        title: "Select OpenCode CUI model",
        matchOnDescription: true,
      })
      if (!picked) return
      const cleaned = picked.label.replace(/^\$\([^)]+\)\s*/, "")
      if (cleaned === "(default)") {
        await this.prefs.setModel(undefined, undefined)
        vscode.window.showInformationMessage("OpenCode CUI: model reset to default")
        return
      }
      const [providerID, ...rest] = cleaned.split("/")
      const modelID = rest.join("/")
      await this.prefs.setModel(providerID, modelID)
      vscode.window.showInformationMessage(`OpenCode CUI: model → ${providerID}/${modelID}`)
    } catch (e) {
      log("pickModel failed", e)
      vscode.window.showErrorMessage(`OpenCode CUI: ${(e as Error).message}`)
    }
  }
}
