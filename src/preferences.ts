import * as vscode from "vscode"

const KEY_AGENT = "opencui.agent"
const KEY_MODEL = "opencui.model"

export type Selection = {
  agent?: string
  modelProviderID?: string
  modelID?: string
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
    }
  }

  async setAgent(agent: string | undefined) {
    await this.state.update(KEY_AGENT, agent ?? "")
    this.emitter.fire(this.get())
  }

  async setModel(providerID: string | undefined, modelID: string | undefined) {
    await this.state.update(`${KEY_MODEL}.providerID`, providerID ?? "")
    await this.state.update(`${KEY_MODEL}.modelID`, modelID ?? "")
    this.emitter.fire(this.get())
  }
}
