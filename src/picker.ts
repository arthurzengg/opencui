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
        vscode.window.showErrorMessage(`OpenCode Panel: failed to load agents`)
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
      const picked = await vscode.window.showQuickPick(items, { title: "Select OpenCode Panel agent" })
      if (!picked) return
      const name = picked.label.replace(/^\$\([^)]+\)\s*/, "")
      if (name === "(default)") {
        await this.prefs.setAgent(undefined)
        vscode.window.showInformationMessage("OpenCode Panel: agent reset to default")
      } else {
        await this.prefs.setAgent(name)
        vscode.window.showInformationMessage(`OpenCode Panel: agent → ${name}`)
      }
    } catch (e) {
      log("pickAgent failed", e)
      vscode.window.showErrorMessage(`OpenCode Panel: ${(e as Error).message}`)
    }
  }

  async pickModel() {
    try {
      const backend = await this.servers.ensure()
      const res = await backend.client.config.providers()
      if (res.error || !res.data) {
        vscode.window.showErrorMessage(`OpenCode Panel: failed to load providers`)
        return
      }
      // SDK Model type doesn't expose `variants` even though the HTTP
      // response includes it (see opencode source `packages/opencode/src/provider/provider.ts:923`).
      // Cast to the local shape that includes the field we care about.
      const rows = listModelRows((res.data.providers ?? []) as unknown as ProviderShape[])
      const items: vscode.QuickPickItem[] = [
        { label: "$(circle-slash) (default)", description: "use opencode default model" },
        ...rows.map((row) => ({
          label: `$(sparkle) ${formatModelRow(row)}`,
          description: row.providerName ?? "",
        })),
      ]
      const picked = await vscode.window.showQuickPick(items, {
        title: "Select OpenCode Panel model",
        matchOnDescription: true,
      })
      if (!picked) return
      const cleaned = picked.label.replace(/^\$\([^)]+\)\s*/, "")
      if (cleaned === "(default)") {
        await this.prefs.setModel(undefined, undefined)
        vscode.window.showInformationMessage("OpenCode Panel: model reset to default")
        return
      }
      const row = rows.find((r) => formatModelRow(r) === cleaned)
      if (!row) {
        log("pickModel: no matching row for", cleaned)
        return
      }
      await this.prefs.setModel(row.providerID, row.modelID, row.variant)
      const display = row.variant ? `${row.providerID}/${row.modelID} · ${row.variant}` : `${row.providerID}/${row.modelID}`
      vscode.window.showInformationMessage(`OpenCode Panel: model → ${display}`)
    } catch (e) {
      log("pickModel failed", e)
      vscode.window.showErrorMessage(`OpenCode Panel: ${(e as Error).message}`)
    }
  }
}

export type ModelRow = {
  providerID: string
  modelID: string
  providerName?: string
  /** Undefined for the model's default variant (the no-variant baseline). */
  variant?: string
}

type ProviderShape = {
  id: string
  name?: string
  models?: Record<string, { variants?: Record<string, unknown> } | undefined>
}

/**
 * Flatten `(provider, model, variant)` into one row per pick. For each
 * model we emit the bare model first (no variant), then one row per
 * variant key — so a user who never wants to tune effort still picks
 * the same way as before, and tuning is one extra row away.
 */
export function listModelRows(providers: ProviderShape[]): ModelRow[] {
  const rows: ModelRow[] = []
  for (const p of providers) {
    for (const [modelID, model] of Object.entries(p.models ?? {})) {
      rows.push({ providerID: p.id, modelID, providerName: p.name })
      const variantKeys = Object.keys(model?.variants ?? {})
      for (const v of variantKeys) {
        rows.push({ providerID: p.id, modelID, providerName: p.name, variant: v })
      }
    }
  }
  return rows
}

export function formatModelRow(row: ModelRow): string {
  return row.variant ? `${row.providerID}/${row.modelID} · ${row.variant}` : `${row.providerID}/${row.modelID}`
}
