import * as vscode from "vscode"
import type { ServerManager, Backend } from "../server"
import type { Preferences } from "../preferences"
import { log } from "../output"
import {
  connectableProviders,
  removableProviders,
  removeProviderAuth,
  UNSUPPORTED_HINT,
  type AuthMethod,
  type ConnectableProvider,
  type ProviderRow,
} from "./provider-format"

/** Sentinel identifying the "Connect a provider" row in the main picker. */
const CONNECT = Symbol("provider-connect")

type ProviderItem = vscode.QuickPickItem & { row?: ProviderRow; connect?: typeof CONNECT }
type MethodItem = vscode.QuickPickItem & { index: number }
type ChoiceItem = vscode.QuickPickItem & { choice: ConnectableProvider }

type ProviderState = {
  rows: ProviderRow[]
  /** providerID -> display name, for the connect list. */
  names: Map<string, string>
  connected: string[]
}

/**
 * Native QuickPick for opencode's AI providers, reachable from the Command
 * Palette (`opencui.manageProviders`) and the `/provider` built-in slash
 * command. Mirrors `src/mcp/manage.ts`: ensure the backend, fetch over the SDK,
 * drive everything through QuickPick, surface results via notifications. The
 * loop re-opens the picker (re-fetching) until the user presses Esc.
 *
 * Connect (API key / OAuth) is fully supported by the released SDK. Disconnect
 * removes stored credentials via an untyped, guarded DELETE — see
 * `removeProviderAuth` for why.
 */
export class ProviderManager {
  constructor(
    private servers: ServerManager,
    private prefs: Preferences,
  ) {}

  async run() {
    let backend: Backend
    try {
      backend = await this.servers.ensure()
    } catch (e) {
      log("provider manage: backend ensure failed", e)
      vscode.window.showErrorMessage(`OpenCode Panel: ${(e as Error).message}`)
      return
    }

    for (;;) {
      const state = await this.fetchState(backend)
      if (!state) return
      const items: ProviderItem[] = [
        { label: "$(add) Connect a provider", connect: CONNECT, alwaysShow: true },
        ...state.rows.map((row): ProviderItem => ({
          label: `$(key) ${row.name}`,
          description: row.removable ? "connected" : "from environment (not removable)",
          row,
        })),
      ]
      const picked = await vscode.window.showQuickPick(items, {
        title: "Manage AI providers",
        placeHolder: state.rows.length ? "Connect a new provider, or disconnect one" : "Connect a provider to get started",
      })
      if (!picked) return
      if (picked.connect) {
        await this.connectFlow(backend, state)
        continue
      }
      if (!picked.row) return
      const row = picked.row
      if (!row.removable) {
        vscode.window.showInformationMessage(
          `OpenCode Panel: "${row.name}" is configured from an environment variable — remove it from your environment or opencode config instead.`,
        )
        continue
      }
      await this.confirmAndDisconnect(backend, row)
    }
  }

  private async fetchState(backend: Backend): Promise<ProviderState | undefined> {
    try {
      const query = { directory: backend.directory }
      const [listRes, cfgRes] = await Promise.all([
        backend.client.provider.list({ query }),
        backend.client.config.providers({ query }),
      ])
      if (listRes.error || !listRes.data) {
        vscode.window.showErrorMessage("OpenCode Panel: failed to load providers")
        return undefined
      }
      const connected = listRes.data.connected ?? []
      const configProviders = cfgRes.data?.providers ?? []
      const names = new Map<string, string>()
      for (const p of listRes.data.all ?? []) names.set(p.id, p.name)
      for (const p of configProviders) if (!names.has(p.id)) names.set(p.id, p.name)
      return { rows: removableProviders(connected, configProviders), names, connected }
    } catch (e) {
      log("provider.list failed", e)
      vscode.window.showErrorMessage(`OpenCode Panel: ${(e as Error).message}`)
      return undefined
    }
  }

  // --- Connect ------------------------------------------------------------

  private async connectFlow(backend: Backend, state: ProviderState) {
    const query = { directory: backend.directory }
    let methodsByProvider: Record<string, AuthMethod[]>
    try {
      const res = await backend.client.provider.auth({ query })
      if (res.error || !res.data) {
        vscode.window.showErrorMessage("OpenCode Panel: failed to load provider login methods")
        return
      }
      methodsByProvider = res.data
    } catch (e) {
      log("provider.auth failed", e)
      vscode.window.showErrorMessage(`OpenCode Panel: ${(e as Error).message}`)
      return
    }

    const choices = connectableProviders(methodsByProvider, state.names, state.connected)
    if (choices.length === 0) {
      vscode.window.showInformationMessage("OpenCode Panel: no providers available to connect.")
      return
    }
    const items: ChoiceItem[] = choices.map((choice) => ({
      label: `$(plug) ${choice.name}`,
      description: choice.connected ? "connected — reconnect" : choice.methods.map((m) => m.label).join(", "),
      choice,
    }))
    const pick = await vscode.window.showQuickPick(items, {
      title: "Connect a provider",
      placeHolder: "Select a provider to connect",
    })
    if (!pick) return
    const choice = pick.choice

    let methodIndex = 0
    if (choice.methods.length > 1) {
      const methodItems: MethodItem[] = choice.methods.map((m, index) => ({ label: m.label, description: m.type, index }))
      const mPick = await vscode.window.showQuickPick(methodItems, {
        title: `Connect ${choice.name}`,
        placeHolder: "Login method",
      })
      if (!mPick) return
      methodIndex = mPick.index
    }
    const method = choice.methods[methodIndex]!
    if (method.type === "api") await this.connectApiKey(backend, choice, method)
    else await this.connectOAuth(backend, choice, methodIndex)
  }

  private async connectApiKey(backend: Backend, choice: ConnectableProvider, method: AuthMethod) {
    const key = await vscode.window.showInputBox({
      title: `Connect ${choice.name}`,
      prompt: method.label,
      password: true,
      ignoreFocusOut: true,
      placeHolder: "Paste your API key",
      validateInput: (v) => (v.trim() ? undefined : "An API key is required"),
    })
    if (!key) return
    try {
      const res = await backend.client.auth.set({
        path: { id: choice.id },
        query: { directory: backend.directory },
        body: { type: "api", key: key.trim() },
      })
      if (res.error) {
        vscode.window.showErrorMessage(`OpenCode Panel: could not connect "${choice.name}"`)
        return
      }
      vscode.window.showInformationMessage(`OpenCode Panel: connected "${choice.name}".`)
    } catch (e) {
      log("auth.set failed", e)
      vscode.window.showErrorMessage(`OpenCode Panel: ${(e as Error).message}`)
    }
  }

  private async connectOAuth(backend: Backend, choice: ConnectableProvider, methodIndex: number) {
    const query = { directory: backend.directory }
    const path = { id: choice.id }
    try {
      const authRes = await backend.client.provider.oauth.authorize({ path, query, body: { method: methodIndex } })
      if (authRes.error || !authRes.data) {
        vscode.window.showErrorMessage(`OpenCode Panel: could not start OAuth for "${choice.name}"`)
        return
      }
      const authz = authRes.data
      if (authz.url) await vscode.env.openExternal(vscode.Uri.parse(authz.url))

      if (authz.method === "auto") {
        // The local opencode server captures the redirect itself — block on the
        // callback while the user finishes in the browser (like MCP authenticate).
        const cbRes = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
            title: `Authorizing "${choice.name}" — finish in your browser...`,
          },
          () => backend.client.provider.oauth.callback({ path, query, body: { method: methodIndex } }),
        )
        if (cbRes.error || cbRes.data !== true) {
          vscode.window.showErrorMessage(`OpenCode Panel: authorization failed for "${choice.name}"`)
          return
        }
        vscode.window.showInformationMessage(`OpenCode Panel: connected "${choice.name}".`)
        return
      }

      // method === "code": the user authorizes in the browser and pastes a code back.
      const code = await vscode.window.showInputBox({
        title: `Connect ${choice.name}`,
        prompt: authz.instructions || "Paste the authorization code from your browser",
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : "An authorization code is required"),
      })
      if (!code) return
      const cbRes = await backend.client.provider.oauth.callback({
        path,
        query,
        body: { method: methodIndex, code: code.trim() },
      })
      if (cbRes.error || cbRes.data !== true) {
        vscode.window.showErrorMessage(`OpenCode Panel: authorization failed for "${choice.name}"`)
        return
      }
      vscode.window.showInformationMessage(`OpenCode Panel: connected "${choice.name}".`)
    } catch (e) {
      log("provider oauth failed", e)
      vscode.window.showErrorMessage(`OpenCode Panel: ${(e as Error).message}`)
    }
  }

  // --- Disconnect ---------------------------------------------------------

  private async confirmAndDisconnect(backend: Backend, row: ProviderRow) {
    const confirm = await vscode.window.showWarningMessage(
      `Remove stored credentials for "${row.name}"?`,
      {
        modal: true,
        detail: "You'll need to re-authenticate with opencode to use this provider's models again.",
      },
      "Remove",
    )
    if (confirm !== "Remove") return

    const result = await removeProviderAuth(backend.url, row.id)
    if (result.kind === "ok") {
      vscode.window.showInformationMessage(`OpenCode Panel: removed credentials for "${row.name}".`)
      await this.warnIfActiveModel(row)
      return
    }
    if (result.kind === "unsupported") {
      const choice = await vscode.window.showWarningMessage(UNSUPPORTED_HINT, "Copy command")
      if (choice === "Copy command") await vscode.env.clipboard.writeText("opencode auth logout")
      return
    }
    vscode.window.showErrorMessage(`OpenCode Panel: could not remove "${row.name}" — ${result.message}`)
  }

  /** If the user's selected model belonged to the removed provider, nudge them to pick another. */
  private async warnIfActiveModel(row: ProviderRow) {
    if (this.prefs.get().modelProviderID !== row.id) return
    const choice = await vscode.window.showWarningMessage(
      `Your selected model used "${row.name}", which is now disconnected. Pick a new model.`,
      "Select model",
    )
    if (choice === "Select model") await vscode.commands.executeCommand("opencui.selectModel")
  }
}
