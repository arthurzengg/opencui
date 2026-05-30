import * as vscode from "vscode"
import type { McpStatus, McpLocalConfig, McpRemoteConfig } from "@opencode-ai/sdk"
import type { ServerManager, Backend } from "../server"
import { log } from "../output"
import {
  actionsFor,
  parseCommand,
  statusError,
  statusIcon,
  statusLabel,
  validateServerName,
  type McpAction,
} from "./status-format"

/** Sentinel identifying the "Add MCP server" row in the main picker. */
const ADD = Symbol("mcp-add")

type ServerItem = vscode.QuickPickItem & { server?: string; add?: typeof ADD }
type ActionItem = vscode.QuickPickItem & { action: McpAction }
type TypeItem = vscode.QuickPickItem & { value: "local" | "remote" }

/**
 * Native QuickPick UI for opencode's MCP (Model Context Protocol) servers,
 * reachable from the Command Palette (`opencui.manageMcp`) and the `/mcp`
 * built-in slash command. Mirrors `src/picker.ts`: ensure the backend, fetch
 * over the SDK, drive everything through QuickPick / InputBox, surface results
 * via notifications.
 *
 * Status is poll-based — the SDK has no MCP push event — so `run()` re-fetches
 * the list on open and after every action (the loop re-opens the picker until
 * the user presses Esc).
 */
export class McpManager {
  constructor(private servers: ServerManager) {}

  async run() {
    let backend: Backend
    try {
      backend = await this.servers.ensure()
    } catch (e) {
      log("mcp manage: backend ensure failed", e)
      vscode.window.showErrorMessage(`OpenCode Panel: ${(e as Error).message}`)
      return
    }

    for (;;) {
      const statusMap = await this.fetchStatus(backend)
      if (!statusMap) return
      const names = Object.keys(statusMap).sort()
      const items: ServerItem[] = [
        { label: "$(add) Add MCP server", add: ADD, alwaysShow: true },
        ...names.map((name): ServerItem => {
          const st = statusMap[name]!
          return {
            label: `${statusIcon(st)} ${name}`,
            description: statusLabel(st),
            detail: statusError(st),
            server: name,
          }
        }),
      ]
      const picked = await vscode.window.showQuickPick(items, {
        title: "Manage MCP servers",
        placeHolder: names.length
          ? "Select a server to manage, or add one"
          : "No MCP servers — add one to get started",
      })
      if (!picked) return
      if (picked.add) {
        await this.addServer(backend, new Set(names))
        continue
      }
      if (picked.server) await this.serverActions(backend, picked.server, statusMap[picked.server]!)
    }
  }

  private async fetchStatus(backend: Backend): Promise<Record<string, McpStatus> | undefined> {
    try {
      const res = await backend.client.mcp.status({ query: { directory: backend.directory } })
      if (res.error || !res.data) {
        vscode.window.showErrorMessage("OpenCode Panel: failed to load MCP status")
        return undefined
      }
      return res.data
    } catch (e) {
      log("mcp.status failed", e)
      vscode.window.showErrorMessage(`OpenCode Panel: ${(e as Error).message}`)
      return undefined
    }
  }

  /** Multi-step Add flow: name → type → command|url → `mcp.add`. */
  private async addServer(backend: Backend, existing: Set<string>) {
    const name = await vscode.window.showInputBox({
      title: "Add MCP server (1/3)",
      prompt: "Server name",
      placeHolder: "e.g. github",
      validateInput: (v) => validateServerName(v, existing),
    })
    if (!name) return
    const serverName = name.trim()

    const type = await vscode.window.showQuickPick<TypeItem>(
      [
        { label: "$(server-process) local", description: "Run a command (stdio server)", value: "local" },
        { label: "$(globe) remote", description: "Connect to an HTTP URL", value: "remote" },
      ],
      { title: "Add MCP server (2/3)", placeHolder: "Connection type" },
    )
    if (!type) return

    let config: McpLocalConfig | McpRemoteConfig
    if (type.value === "local") {
      const command = await vscode.window.showInputBox({
        title: "Add MCP server (3/3)",
        prompt: "Command to run",
        placeHolder: "e.g. npx -y @modelcontextprotocol/server-github",
        validateInput: (v) => (parseCommand(v).length === 0 ? "A command is required" : undefined),
      })
      if (!command) return
      config = { type: "local", command: parseCommand(command), enabled: true }
    } else {
      const url = await vscode.window.showInputBox({
        title: "Add MCP server (3/3)",
        prompt: "Server URL",
        placeHolder: "https://example.com/mcp",
        validateInput: (v) => {
          try {
            new URL(v.trim())
            return undefined
          } catch {
            return "Enter a valid URL"
          }
        },
      })
      if (!url) return
      config = { type: "remote", url: url.trim(), enabled: true }
    }

    try {
      const res = await backend.client.mcp.add({
        body: { name: serverName, config },
        query: { directory: backend.directory },
      })
      if (res.error) {
        vscode.window.showErrorMessage(
          `OpenCode Panel: could not add "${serverName}" — ${errorMessage(res.error)}`,
        )
        return
      }
      const st = res.data?.[serverName]
      const suffix = st ? ` (${statusLabel(st)})` : ""
      // `mcp.add` registers the server for the running session only — it is NOT
      // written to opencode.json, so it is gone after a server restart.
      vscode.window.showInformationMessage(
        `OpenCode Panel: added "${serverName}"${suffix} for this session. Add it to your opencode config to make it permanent.`,
      )
    } catch (e) {
      log("mcp.add failed", e)
      vscode.window.showErrorMessage(`OpenCode Panel: ${(e as Error).message}`)
    }
  }

  /** Second picker: the actions valid for this server's status, then dispatch. */
  private async serverActions(backend: Backend, name: string, status: McpStatus) {
    const items: ActionItem[] = actionsFor(status).map((action) => ({ label: actionLabel(action), action }))
    const picked = await vscode.window.showQuickPick(items, {
      title: `${name} — ${statusLabel(status)}`,
      placeHolder: "Choose an action",
    })
    if (!picked) return
    await this.runAction(backend, name, status, picked.action)
  }

  private async runAction(backend: Backend, name: string, status: McpStatus, action: McpAction) {
    const query = { directory: backend.directory }
    try {
      switch (action) {
        case "connect": {
          const res = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, cancellable: false, title: `Connecting "${name}"...` },
            () => backend.client.mcp.connect({ path: { name }, query }),
          )
          if (res.error) vscode.window.showErrorMessage(`OpenCode Panel: could not connect "${name}"`)
          return
        }
        case "disconnect": {
          const res = await backend.client.mcp.disconnect({ path: { name }, query })
          if (res.error) vscode.window.showErrorMessage(`OpenCode Panel: could not disconnect "${name}"`)
          return
        }
        case "authenticate": {
          // The opencode server (a local subprocess) opens the browser and
          // captures the OAuth redirect itself, then returns the new status —
          // so this is one blocking call, no URI handler / code paste needed.
          const res = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              cancellable: false,
              title: `Authenticating "${name}" — finish in your browser...`,
            },
            () => backend.client.mcp.auth.authenticate({ path: { name }, query }),
          )
          if (res.error || !res.data) {
            vscode.window.showErrorMessage(`OpenCode Panel: authentication failed for "${name}"`)
            return
          }
          vscode.window.showInformationMessage(`OpenCode Panel: "${name}" is now ${statusLabel(res.data)}`)
          return
        }
        case "signout": {
          const res = await backend.client.mcp.auth.remove({ path: { name }, query })
          // 404 = nothing stored (e.g. a local server) — informational, not an error.
          if (res.error) {
            vscode.window.showInformationMessage(`OpenCode Panel: no stored OAuth credentials for "${name}"`)
            return
          }
          vscode.window.showInformationMessage(`OpenCode Panel: removed OAuth credentials for "${name}"`)
          return
        }
        case "showError": {
          const err = statusError(status) ?? "Unknown error"
          const choice = await vscode.window.showErrorMessage(`OpenCode Panel: "${name}" — ${err}`, "Copy")
          if (choice === "Copy") await vscode.env.clipboard.writeText(err)
          return
        }
      }
    } catch (e) {
      log(`mcp action ${action} failed`, e)
      vscode.window.showErrorMessage(`OpenCode Panel: ${(e as Error).message}`)
    }
  }
}

function actionLabel(action: McpAction): string {
  switch (action) {
    case "connect":
      return "$(plug) Connect"
    case "disconnect":
      return "$(debug-disconnect) Disconnect"
    case "authenticate":
      return "$(key) Authenticate"
    case "signout":
      return "$(sign-out) Remove OAuth credentials"
    case "showError":
      return "$(error) Show error"
  }
}

/** Best-effort message extraction from an SDK error union (e.g. BadRequestError). */
function errorMessage(err: unknown): string {
  if (typeof err === "string") return err
  if (err && typeof err === "object") {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
    const message = (err as { message?: string }).message
    if (message) return message
  }
  return "bad request"
}
