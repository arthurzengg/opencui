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

  /**
   * Single-step model picker — pick a model and you're done. Variant /
   * effort tuning has moved entirely to the StatusBar's Effort row
   * (`pickVariantForCurrent`) so picking a model never asks a second
   * question; the dropdown is short and the two concerns stay
   * orthogonal.
   *
   * Variant is always reset on a successful model change: variants are
   * model-scoped (e.g. `max` exists on Sonnet 4.6 but not on Haiku
   * 4.5), so carrying the prior variant string forward to a different
   * model would silently produce an invalid combo. The Effort row in
   * the StatusBar lets the user retune effort immediately afterward.
   * Models with variants show an `effort: …` hint in the detail line
   * so users know the knob exists.
   */
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
      const models = listModels((res.data.providers ?? []) as unknown as ProviderShape[])
      const items: vscode.QuickPickItem[] = [
        { label: "$(circle-slash) (default)", description: "use opencode default model" },
        ...models.map((m) => ({
          label: `$(sparkle) ${m.providerID}/${m.modelID}`,
          description: m.providerName ?? "",
          detail: variantDetail(m),
        })),
      ]
      const picked = await vscode.window.showQuickPick(items, {
        title: "Select OpenCode Panel model",
        matchOnDescription: true,
      })
      if (!picked) return
      const cleaned = picked.label.replace(/^\$\([^)]+\)\s*/, "")
      if (cleaned === "(default)") {
        await this.prefs.setModel(undefined, undefined, undefined)
        vscode.window.showInformationMessage("OpenCode Panel: model reset to default")
        return
      }
      const model = models.find((m) => `${m.providerID}/${m.modelID}` === cleaned)
      if (!model) {
        log("pickModel: no matching model for", cleaned)
        return
      }
      await this.prefs.setModel(model.providerID, model.modelID, undefined)
      const hint = model.variants.length > 0 ? " — tune effort from the StatusBar" : ""
      vscode.window.showInformationMessage(
        `OpenCode Panel: model → ${model.providerID}/${model.modelID}${hint}`,
      )
    } catch (e) {
      log("pickModel failed", e)
      vscode.window.showErrorMessage(`OpenCode Panel: ${(e as Error).message}`)
    }
  }

  /**
   * Variant-only picker for the *current* model. Used by the StatusBar's
   * Effort row so the user can change effort without re-picking the model.
   *
   * Edge cases:
   *   - No model selected (using opencode default): tell the user — variants
   *     are model-scoped, we can't pick one without knowing the model.
   *   - Selected model has no variants: tell the user — there's nothing to
   *     pick (and surface this via the info channel rather than silently
   *     opening an empty picker).
   *   - Esc: abort without changing the current variant.
   */
  async pickVariantForCurrent() {
    try {
      const current = this.prefs.get()
      if (!current.modelProviderID || !current.modelID) {
        vscode.window.showInformationMessage(
          "OpenCode Panel: pick a model first — effort is a per-model setting.",
        )
        return
      }
      const backend = await this.servers.ensure()
      const res = await backend.client.config.providers()
      if (res.error || !res.data) {
        vscode.window.showErrorMessage(`OpenCode Panel: failed to load providers`)
        return
      }
      const models = listModels((res.data.providers ?? []) as unknown as ProviderShape[])
      const model = models.find(
        (m) => m.providerID === current.modelProviderID && m.modelID === current.modelID,
      )
      if (!model) {
        vscode.window.showWarningMessage(
          `OpenCode Panel: ${current.modelProviderID}/${current.modelID} no longer reported by opencode — open the model picker to choose another.`,
        )
        return
      }
      if (model.variants.length === 0) {
        vscode.window.showInformationMessage(
          `OpenCode Panel: ${current.modelProviderID}/${current.modelID} has no effort variants.`,
        )
        return
      }
      const picked = await this.pickVariant(model, current)
      if (picked === ABORT) return
      await this.prefs.setModel(model.providerID, model.modelID, picked)
      const display = picked
        ? `${model.providerID}/${model.modelID} · ${picked}`
        : `${model.providerID}/${model.modelID}`
      vscode.window.showInformationMessage(`OpenCode Panel: model → ${display}`)
    } catch (e) {
      log("pickVariantForCurrent failed", e)
      vscode.window.showErrorMessage(`OpenCode Panel: ${(e as Error).message}`)
    }
  }

  /**
   * Step 2 of `pickModel`. Returns the chosen variant, `undefined` for the
   * model's default (the `(default)` row), or `ABORT` if the user pressed
   * Esc (so the caller aborts the whole pick instead of clearing the
   * variant unintentionally).
   */
  private async pickVariant(
    model: ModelInfo,
    current: { modelProviderID?: string; modelID?: string; modelVariant?: string },
  ): Promise<string | undefined | typeof ABORT> {
    const isCurrentModel =
      current.modelProviderID === model.providerID && current.modelID === model.modelID
    const items: vscode.QuickPickItem[] = [
      {
        label: "$(circle-slash) (default)",
        description: "use the model's default effort",
        picked: isCurrentModel && !current.modelVariant,
      },
      ...model.variants.map((v) => ({
        label: `$(zap) ${v}`,
        picked: isCurrentModel && current.modelVariant === v,
      })),
    ]
    const picked = await vscode.window.showQuickPick(items, {
      title: `Effort for ${model.providerID}/${model.modelID}`,
      placeHolder: "Higher effort = more reasoning tokens, slower, more expensive",
    })
    if (!picked) return ABORT
    const v = picked.label.replace(/^\$\([^)]+\)\s*/, "")
    return v === "(default)" ? undefined : v
  }
}

const ABORT = Symbol("pick-variant-aborted")

export type ModelInfo = {
  providerID: string
  modelID: string
  providerName?: string
  /** Variant keys in declared order. Empty if the model has no variants. */
  variants: string[]
}

type ProviderShape = {
  id: string
  name?: string
  models?: Record<string, { variants?: Record<string, unknown> } | undefined>
}

/**
 * One entry per `(provider, model)` — variants are attached as a list, not
 * exploded into separate rows. The picker uses a second QuickPick to choose
 * a variant when this list is non-empty.
 */
export function listModels(providers: ProviderShape[]): ModelInfo[] {
  const models: ModelInfo[] = []
  for (const p of providers) {
    for (const [modelID, model] of Object.entries(p.models ?? {})) {
      models.push({
        providerID: p.id,
        modelID,
        providerName: p.name,
        variants: Object.keys(model?.variants ?? {}),
      })
    }
  }
  return models
}

/** Right-aligned hint shown on each model row when it has variants. */
export function variantDetail(model: ModelInfo): string | undefined {
  if (model.variants.length === 0) return undefined
  // Show the variant keys directly when there's room (≤4); otherwise just the count.
  if (model.variants.length <= 4) return `effort: ${model.variants.join(" · ")}`
  return `${model.variants.length} effort variants: ${model.variants.slice(0, 3).join(" · ")}…`
}
