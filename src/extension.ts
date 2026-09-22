import * as vscode from "vscode"
import { ServerManager } from "./server"
import { StatusBar } from "./status"
import { ChatView } from "./chat/view"
import { InlineEdit } from "./inline/edit"
import { Preferences } from "./preferences"
import { Picker } from "./picker"
import { McpManager } from "./mcp/manage"
import { ProviderManager } from "./provider/manage"
import { RecentEditsTracker } from "./workspace-context/recent-edits"
import { IndexManager, readIndexSettings } from "./indexing/index-manager"
import { AgentTaskStore } from "./agents/task-store"
import { showAgentsQuickPick } from "./agents/quickpick"
import { getOutputChannel, log } from "./output"
import { initFileSearch } from "./file-search"
import { reapOrphanServers, registryPath } from "./server-registry"
import { BinaryUpdateWatch, readBinaryVersion } from "./binary-update"

let servers: ServerManager | undefined
let recentEdits: RecentEditsTracker | undefined
let indexManager: IndexManager | undefined
let agentTaskStore: AgentTaskStore | undefined
let chatView: ChatView | undefined

export async function activate(context: vscode.ExtensionContext) {
  log("activating OpenCode Panel")
  // Sweep servers orphaned by killed extension hosts (debugger Stop, host
  // crash) — those paths never run deactivate, and opencode has no
  // parent-death watchdog of its own.
  const storageDir = context.globalStorageUri?.fsPath
  if (storageDir) {
    void reapOrphanServers(registryPath(storageDir), process.pid).then(
      (killed) => {
        if (killed.length) log("reaped orphaned opencode servers", killed)
      },
      (e) => log("orphan server reap failed", e),
    )
  }
  servers = new ServerManager(context)
  recentEdits = new RecentEditsTracker()
  const indexSettings = readIndexSettings(vscode.workspace.getConfiguration("opencui"))
  indexManager = new IndexManager(indexSettings)
  agentTaskStore = new AgentTaskStore(context.workspaceState)
  initFileSearch(context)
  context.subscriptions.push(
    { dispose: () => recentEdits?.dispose() },
    { dispose: () => void indexManager?.stop() },
    { dispose: () => agentTaskStore?.dispose() },
  )
  const prefs = new Preferences(context.globalState)
  const status = new StatusBar(context, prefs)
  const chat = new ChatView(context, servers, prefs, recentEdits, indexManager, agentTaskStore)
  chatView = chat
  const inline = new InlineEdit(servers, prefs)
  const picker = new Picker(servers, prefs)
  const mcp = new McpManager(servers)
  const providers = new ProviderManager(servers, prefs)

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatView.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("opencui.chat.focus", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.opencui")
      chat.focus()
    }),
    vscode.commands.registerCommand("opencui.chat.new", () => chat.newSession()),
    vscode.commands.registerCommand("opencui.chat.addSelection", () => chat.addSelectionToChat()),
    vscode.commands.registerCommand("opencui.conversation.select", () => chat.pickConversation()),
    vscode.commands.registerCommand("opencui.inlineEdit", () => inline.run()),
    vscode.commands.registerCommand("opencui.selectAgent", () => picker.pickAgent()),
    vscode.commands.registerCommand("opencui.selectModel", () => picker.pickModel()),
    vscode.commands.registerCommand("opencui.selectVariant", () => picker.pickVariantForCurrent()),
    vscode.commands.registerCommand("opencui.manageMcp", () => mcp.run()),
    vscode.commands.registerCommand("opencui.manageProviders", () => providers.run()),
    vscode.commands.registerCommand("opencui.agents.open", () =>
      showAgentsQuickPick(agentTaskStore!, chat.activeConversationID()),
    ),
    vscode.commands.registerCommand("opencui.server.restart", async () => {
      status.set("starting", "restarting backend")
      await servers!.restart().then(
        () => status.set("ready"),
        (e) => status.set("error", String(e)),
      )
    }),
    vscode.commands.registerCommand("opencui.showLogs", () => getOutputChannel().show()),
  )

  // An opencode upgraded in a terminal leaves this server on the old binary
  // until the window reloads; offer the restart instead (#615).
  const binaryWatch = new BinaryUpdateWatch({
    runningVersion: () => servers!.currentVersion(),
    readVersion: () => {
      const binaryPath = servers!.currentBinaryPath()
      return binaryPath ? readBinaryVersion(binaryPath) : Promise.resolve(undefined)
    },
    offerRestart: async (installed, running) => {
      const choice = await vscode.window.showInformationMessage(
        `opencode ${installed} is installed, but OpenCode Panel is still running ${running}.`,
        "Restart Server",
      )
      return choice === "Restart Server"
    },
    restart: async () => {
      await vscode.commands.executeCommand("opencui.server.restart")
    },
  })
  context.subscriptions.push(chat.onDidUserActivity(() => void binaryWatch.check()))

  servers
    .ensure()
    .then(() => status.set("ready"))
    .catch((e) => {
      log("failed to start backend", e)
      status.set("error", String(e))
      vscode.window.showErrorMessage(`OpenCode Panel: failed to start opencode backend: ${e.message}`)
    })

  // Test-facing API (ext.exports). The integration suite polls this to verify
  // the real webview bundle loads and completes the mounted handshake.
  return {
    chatWebviewState: () => chat.webviewState(),
  }
}

export async function deactivate() {
  // Flush any debounced conversation write before the host tears down so a
  // graceful shutdown mid-stream persists the full transcript.
  await chatView?.flushPersist()
  await servers?.dispose()
}
