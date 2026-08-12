import * as vscode from "vscode"
import type { ServerManager } from "./server"
import type { Preferences } from "./preferences"
import type { ModelCatalogInfo } from "./protocol"
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
   * Single-step model picker — pick a model and you're done. Effort is
   * tuned separately (the panel's picker chips or `pickVariantForCurrent`)
   * so picking a model never asks a second question.
   *
   * The variant is never carried over from the PREVIOUS model (variants are
   * model-scoped; e.g. `max` exists on Sonnet 4.6 but not on Haiku 4.5).
   * Instead the last variant used with the PICKED model is restored from
   * per-model memory, validated against its live variant list — switching
   * away and back keeps the effort tuning without ever minting an invalid
   * combo.
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
      const variant = validVariant(model, this.prefs.variantFor(model.providerID, model.modelID))
      await this.prefs.setModel(model.providerID, model.modelID, variant)
      const display = variant
        ? `${model.providerID}/${model.modelID} · ${variant}`
        : `${model.providerID}/${model.modelID}`
      vscode.window.showInformationMessage(`OpenCode Panel: model → ${display}`)
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
      const picked = await this.pickVariant(model, current.modelVariant)
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
   * Helper for `pickVariantForCurrent`. Returns the chosen variant,
   * `undefined` for the model's default (the `(default)` row), or
   * `ABORT` if the user pressed Esc (so the caller leaves the active
   * variant untouched).
   */
  private async pickVariant(
    model: ModelInfo,
    currentVariant?: string,
  ): Promise<string | undefined | typeof ABORT> {
    const items: vscode.QuickPickItem[] = [
      {
        label: "$(circle-slash) (default)",
        description: "use the model's default effort",
        picked: !currentVariant,
      },
      ...model.variants.map((v) => ({
        label: `$(zap) ${v}`,
        picked: currentVariant === v,
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

export type ProviderShape = {
  id: string
  name?: string
  models?: Record<string, { variants?: Record<string, unknown> } | undefined>
}

/**
 * One entry per `(provider, model)` — variants are attached as a list
 * for callers that want to surface them separately (the StatusBar's
 * Effort row reads from this to populate the variant picker).
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

/**
 * A variant is only meaningful for the model it was declared on. With the
 * model at hand, membership is enforced; without it (webview `setModel`
 * arriving before the catalog loaded), the variant is trusted — opencode
 * ignores unknown variant keys, and dropping it would lose a valid pick.
 */
export function validVariant(
  model: ModelInfo | undefined,
  variant: string | undefined,
): string | undefined {
  if (!variant) return undefined
  if (!model) return variant
  return model.variants.includes(variant) ? variant : undefined
}

/**
 * Wire catalog for the in-panel picker. Recents are filtered to models that
 * still exist (an opencode config change must not leave dead rows), and each
 * entry carries the validated per-model variant memory so the webview can
 * restore effort on selection without a round-trip.
 */
export function buildModelCatalog(
  models: ModelInfo[],
  recents: string[],
  variantFor: (providerID: string, modelID: string) => string | undefined,
): ModelCatalogInfo {
  const keys = new Set(models.map((m) => `${m.providerID}/${m.modelID}`))
  return {
    models: models.map((m) => ({
      providerID: m.providerID,
      modelID: m.modelID,
      providerName: m.providerName,
      variants: m.variants,
      lastVariant: validVariant(m, variantFor(m.providerID, m.modelID)),
    })),
    recents: recents.filter((key) => keys.has(key)),
  }
}

