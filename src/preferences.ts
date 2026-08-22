import * as vscode from "vscode"

const KEY_AGENT = "opencui.agent"
const KEY_MODEL = "opencui.model"
const KEY_MODEL_RECENTS = "opencui.model.recents"
const KEY_MODEL_VARIANT_MEMORY = "opencui.model.variantMemory"
const KEY_MODEL_COLLAPSED_PROVIDERS = "opencui.model.collapsedProviders"

/**
 * Enough to cover a "testing new LLM releases across 4-5 providers" rotation
 * with one slot to spare; beyond that the picker's full list is close anyway.
 */
const MAX_RECENT_MODELS = 6

export type Selection = {
  agent?: string
  modelProviderID?: string
  modelID?: string
  /**
   * Optional model variant — corresponds to a key under
   * `provider.models[modelID].variants` in the opencode config. Maps to
   * `reasoningEffort` (OpenAI) or thinking-budget (Anthropic) at the
   * server; sent as a sibling of `modelID` on prompt requests. Undefined
   * = use the model's default variant.
   */
  modelVariant?: string
}

export class Preferences {
  private emitter = new vscode.EventEmitter<Selection>()
  readonly onChange = this.emitter.event

  constructor(private state: vscode.Memento) {}

  get(): Selection {
    return {
      agent: this.state.get<string>(KEY_AGENT) || undefined,
      modelProviderID: this.state.get<string>(`${KEY_MODEL}.providerID`) || undefined,
      modelID: this.state.get<string>(`${KEY_MODEL}.modelID`) || undefined,
      modelVariant: this.state.get<string>(`${KEY_MODEL}.variant`) || undefined,
    }
  }

  /** `providerID/modelID` keys, most recently selected first. */
  recentModels(): string[] {
    const raw = this.state.get<unknown>(KEY_MODEL_RECENTS)
    if (!Array.isArray(raw)) return []
    return raw.filter((v): v is string => typeof v === "string")
  }

  /** Last variant the user picked for this model; undefined = its default. */
  variantFor(providerID: string, modelID: string): string | undefined {
    return this.variantMemory()[`${providerID}/${modelID}`]
  }

  /** Provider IDs whose model-picker group the user folded. */
  collapsedProviders(): string[] {
    const raw = this.state.get<unknown>(KEY_MODEL_COLLAPSED_PROVIDERS)
    if (!Array.isArray(raw)) return []
    return raw.filter((v): v is string => typeof v === "string")
  }

  async setProviderCollapsed(providerID: string, collapsed: boolean) {
    const rest = this.collapsedProviders().filter((id) => id !== providerID)
    await this.state.update(KEY_MODEL_COLLAPSED_PROVIDERS, collapsed ? [...rest, providerID] : rest)
  }

  async setAgent(agent: string | undefined) {
    await this.state.update(KEY_AGENT, agent ?? "")
    this.emitter.fire(this.get())
  }

  async setModel(providerID: string | undefined, modelID: string | undefined, variant?: string) {
    await this.state.update(`${KEY_MODEL}.providerID`, providerID ?? "")
    await this.state.update(`${KEY_MODEL}.modelID`, modelID ?? "")
    await this.state.update(`${KEY_MODEL}.variant`, variant ?? "")
    // Recents and per-model variant memory track concrete picks only — a
    // reset to the opencode default says nothing about which models the
    // user rotates between.
    if (providerID && modelID) {
      const key = `${providerID}/${modelID}`
      const recents = [key, ...this.recentModels().filter((k) => k !== key)]
      await this.state.update(KEY_MODEL_RECENTS, recents.slice(0, MAX_RECENT_MODELS))
      const memory = { ...this.variantMemory() }
      if (variant) memory[key] = variant
      else delete memory[key]
      await this.state.update(KEY_MODEL_VARIANT_MEMORY, memory)
    }
    this.emitter.fire(this.get())
  }

  private variantMemory(): Record<string, string> {
    const raw = this.state.get<unknown>(KEY_MODEL_VARIANT_MEMORY)
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
    const memory: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") memory[key] = value
    }
    return memory
  }
}
