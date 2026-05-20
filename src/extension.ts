import * as vscode from "vscode"
import { ServerManager } from "./server"
import { StatusBar } from "./status"
import { ChatView } from "./chat/view"
import { InlineEdit } from "./inline/edit"
import { Preferences } from "./preferences"
import { Picker } from "./picker"
import { RecentEditsTracker } from "./workspace-context/recent-edits"
import { IndexManager, readIndexSettings } from "./indexing/index-manager"
import { getOutputChannel, log } from "./output"

let servers: ServerManager | undefined
let recentEdits: RecentEditsTracker | undefined
let indexManager: IndexManager | undefined

export async function activate(context: vscode.ExtensionContext) {
  log("activating OpenCode Panel")
  servers = new ServerManager(context)
  recentEdits = new RecentEditsTracker()
  const indexSettings = readIndexSettings(vscode.workspace.getConfiguration("opencui"))
  indexManager = new IndexManager(indexSettings)
  context.subscriptions.push(
    { dispose: () => recentEdits?.dispose() },
    { dispose: () => void indexManager?.stop() },
  )
  const prefs = new Preferences(context.globalState)
  const status = new StatusBar(context, prefs)
  const chat = new ChatView(context, servers, prefs, recentEdits, indexManager)
  const inline = new InlineEdit(servers, prefs)
  const picker = new Picker(servers, prefs)

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatView.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("opencui.chat.focus", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.opencui")
      chat.focus()
    }),
    vscode.commands.registerCommand("opencui.chat.new", () => chat.newSession()),
    vscode.commands.registerCommand("opencui.conversation.select", () => chat.pickConversation()),
    vscode.commands.registerCommand("opencui.inlineEdit", () => inline.run()),
    vscode.commands.registerCommand("opencui.selectAgent", () => picker.pickAgent()),
    vscode.commands.registerCommand("opencui.selectModel", () => picker.pickModel()),
    vscode.commands.registerCommand("opencui.selectVariant", () => picker.pickVariantForCurrent()),
    vscode.commands.registerCommand("opencui.server.restart", async () => {
      status.set("starting", "restarting backend")
      await servers!.restart().then(
        () => status.set("ready"),
        (e) => status.set("error", String(e)),
      )
    }),
    vscode.commands.registerCommand("opencui.showLogs", () => getOutputChannel().show()),
  )

  servers
    .ensure()
    .then(() => status.set("ready"))
    .catch((e) => {
      log("failed to start backend", e)
      status.set("error", String(e))
      vscode.window.showErrorMessage(`OpenCode Panel: failed to start opencode backend: ${e.message}`)
    })
}

export async function deactivate() {
  await servers?.dispose()
}
