import * as vscode from "vscode"
import type { ServerManager, Backend } from "../server"
import type { Preferences } from "../preferences"
import { log } from "../output"
import { removableProviders, removeProviderAuth, UNSUPPORTED_HINT, type ProviderRow } from "./provider-format"

type ProviderItem = vscode.QuickPickItem & { row?: ProviderRow }

/**
 * Native QuickPick for opencode's AI providers, reachable from the Command
 * Palette (`opencui.manageProviders`) and the `/provider` built-in slash
 * command. Mirrors `src/mcp/manage.ts`: ensure the backend, fetch over the SDK,
 * drive everything through QuickPick, surface results via notifications. The
 * loop re-opens the picker (re-fetching the list) until the user presses Esc.
 *
 * v1 is disconnect-only: it lists the authenticated providers
 * (`provider.list().connected`) and removes a provider's stored credentials.
 * Connecting / authenticating a provider (opencode's API-key / OAuth flow) is a
 * separate, larger surface and is intentionally out of scope here.
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
      const rows = await this.fetchProviders(backend)
      if (!rows) return
      const items: ProviderItem[] = rows.map((row) => ({
        label: `$(key) ${row.name}`,
        description: row.removable ? "connected" : "from environment (not removable)",
        row,
      }))
      const picked = await vscode.window.showQuickPick(items, {
        title: "Manage AI providers",
        placeHolder: rows.length ? "Select a provider to disconnect" : "No connected providers",
      })
      if (!picked || !picked.row) return
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

  private async fetchProviders(backend: Backend): Promise<ProviderRow[] | undefined> {
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
      return removableProviders(listRes.data.connected ?? [], cfgRes.data?.providers ?? [])
    } catch (e) {
      log("provider.list failed", e)
      vscode.window.showErrorMessage(`OpenCode Panel: ${(e as Error).message}`)
      return undefined
    }
  }

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
