import * as vscode from "vscode"
import * as path from "path"
import type { ServerManager, Backend } from "../server"
import type { Preferences } from "../preferences"
import {
  subscribeSession,
  type ToolUpdate,
  type PermissionRequest,
  type Subscription,
} from "./stream"
import { getEditorContext, formatContextHeader } from "../context"
import { log } from "../output"
import type {
  ChatMessage,
  ConversationSummary,
  Inbound,
  Outbound,
  Todo,
  ToolUpdate as WireToolUpdate,
  Selection,
  ReviewChange,
  ReviewHunkState,
} from "../protocol"

const CONVERSATIONS_KEY = "opencui.conversations"
const ACTIVE_CONVERSATION_KEY = "opencui.activeConversation"

type SavedConversation = ConversationSummary & {
  createdAt: number
  sessionID?: string
  messages: ChatMessage[]
  todos: Todo[]
  reviewHunks?: Record<string, ReviewHunkState>
}

export class ChatView implements vscode.WebviewViewProvider {
  static viewType = "opencui.chat"

  private view?: vscode.WebviewView
  private sessionID?: string
  private subscription?: Subscription
  private activePermissions = new Map<string, PermissionRequest>()
  /** opencode messageID → webview-side id used in UI */
  private messageMap = new Map<string, string>()
  private conversations: SavedConversation[]
  private activeConversationID: string
  private messages: ChatMessage[] = []
  private todos: Todo[] = []
  private reviewHunks: Record<string, ReviewHunkState> = {}
  private reviewPanel?: vscode.WebviewPanel
  private reviewChange?: ReviewChange

  constructor(
    private context: vscode.ExtensionContext,
    private servers: ServerManager,
    private prefs: Preferences,
  ) {
    this.conversations = context.globalState.get<SavedConversation[]>(CONVERSATIONS_KEY) ?? []
    this.activeConversationID = context.globalState.get<string>(ACTIVE_CONVERSATION_KEY) ?? ""
    if (!this.conversations.length) this.addConversation("New conversation")
    if (!this.conversations.some((c) => c.id === this.activeConversationID)) {
      this.activeConversationID = this.conversations[0]!.id
    }
    this.restoreActiveState()
    void this.persistConversations()
  }

  async resolveWebviewView(view: vscode.WebviewView) {
    log("ChatView.resolveWebviewView called")
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    }
    try {
      view.webview.html = await this.buildHtml(view.webview)
      log("ChatView html set (length=" + view.webview.html.length + ")")
    } catch (e) {
      log("ChatView html build failed", e)
      view.webview.html = fallbackHtml(`Failed to build webview: ${(e as Error).message}`)
    }
    view.webview.onDidReceiveMessage((msg: Inbound) => this.onMessage(msg))
    view.onDidDispose(() => this.dispose())

    vscode.window.onDidChangeActiveTextEditor(() => this.pushContext(), null, this.context.subscriptions)
    vscode.window.onDidChangeTextEditorSelection(
      () => this.pushContext(),
      null,
      this.context.subscriptions,
    )
    this.prefs.onChange(() => this.postSelection())
  }

  focus() {
    this.view?.show?.(true)
  }

  async newSession() {
    await this.createConversation()
  }

  async createConversation() {
    this.subscription?.abort()
    this.subscription = undefined
    this.sessionID = undefined
    this.messageMap.clear()
    this.activePermissions.clear()
    const conversation = this.addConversation("New conversation")
    this.activeConversationID = conversation.id
    this.messages = []
    this.todos = []
    this.reviewHunks = {}
    await this.persistConversations()
    this.sendConversationState()
  }

  async pickConversation() {
    const picked = await vscode.window.showQuickPick(
      [
        { label: "$(plus) New conversation", description: "Start a saved conversation", create: true },
        ...this.conversationSummaries().map((c) => ({
          label: c.title,
          description: c.id === this.activeConversationID ? "current" : new Date(c.updatedAt).toLocaleString(),
          id: c.id,
        })),
      ],
      { title: "Select OpenCUI conversation" },
    )
    if (!picked) return
    if ("create" in picked) {
      await this.createConversation()
      return
    }
    if ("id" in picked && typeof picked.id === "string") await this.selectConversation(picked.id)
  }

  private dispose() {
    this.subscription?.abort()
    this.subscription = undefined
    this.reviewPanel?.dispose()
    this.reviewPanel = undefined
  }

  private post(msg: Outbound) {
    this.applyLocal(msg)
    this.view?.webview.postMessage(msg)
  }

  private sendConversationState() {
    this.post({
      type: "conversations",
      conversations: this.conversationSummaries(),
      activeID: this.activeConversationID,
    })
    this.post({
      type: "restore",
      conversationID: this.activeConversationID,
      messages: this.messages,
      todos: this.todos,
      reviewHunks: this.reviewHunks,
    })
  }

  private addConversation(title: string): SavedConversation {
    const now = Date.now()
    const conversation: SavedConversation = {
      id: `conv_${now}_${Math.random().toString(36).slice(2)}`,
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
      todos: [],
      reviewHunks: {},
    }
    this.conversations = [conversation, ...this.conversations]
    return conversation
  }

  private conversationSummaries(): ConversationSummary[] {
    return this.conversations
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private restoreActiveState() {
    const conversation = this.activeConversation()
    this.sessionID = conversation.sessionID
    this.messages = conversation.messages.map((m) => ({ ...m, pending: false }))
    this.todos = conversation.todos
    this.reviewHunks = conversation.reviewHunks ?? {}
  }

  private async selectConversation(id: string) {
    if (id === this.activeConversationID) return
    this.subscription?.abort()
    this.subscription = undefined
    this.messageMap.clear()
    this.activePermissions.clear()
    this.activeConversationID = id
    this.restoreActiveState()
    await this.persistConversations()
    this.sendConversationState()
  }

  private async renameConversation(id: string, title: string) {
    const nextTitle = title.replace(/\s+/g, " ").trim().slice(0, 80)
    if (!nextTitle) return
    this.conversations = this.conversations.map((conversation) =>
      conversation.id === id ? { ...conversation, title: nextTitle, updatedAt: Date.now() } : conversation,
    )
    await this.persistConversations()
    this.post({
      type: "conversations",
      conversations: this.conversationSummaries(),
      activeID: this.activeConversationID,
    })
  }

  private async deleteConversation(id: string) {
    this.conversations = this.conversations.filter((conversation) => conversation.id !== id)
    if (!this.conversations.length) this.addConversation("New conversation")
    if (this.activeConversationID === id) {
      this.subscription?.abort()
      this.subscription = undefined
      this.messageMap.clear()
      this.activePermissions.clear()
      this.activeConversationID = this.conversationSummaries()[0]!.id
      this.restoreActiveState()
      await this.persistConversations()
      this.sendConversationState()
      return
    }
    await this.persistConversations()
    this.post({
      type: "conversations",
      conversations: this.conversationSummaries(),
      activeID: this.activeConversationID,
    })
  }

  private activeConversation(): SavedConversation {
    const conversation = this.conversations.find((c) => c.id === this.activeConversationID)
    if (conversation) return conversation
    const created = this.addConversation("New conversation")
    this.activeConversationID = created.id
    return created
  }

  private updateActive(fn: (conversation: SavedConversation) => SavedConversation) {
    const next = fn(this.activeConversation())
    this.conversations = [next, ...this.conversations.filter((c) => c.id !== next.id)]
    void this.persistConversations()
  }

  private async persistConversations() {
    await this.context.globalState.update(CONVERSATIONS_KEY, this.conversations)
    await this.context.globalState.update(ACTIVE_CONVERSATION_KEY, this.activeConversationID)
  }

  private saveActive() {
    this.updateActive((conversation) => ({
      ...conversation,
      sessionID: this.sessionID,
      messages: this.messages,
      todos: this.todos,
      reviewHunks: this.reviewHunks,
      updatedAt: Date.now(),
    }))
  }

  private updateTitleFromPrompt(text: string) {
    const conversation = this.activeConversation()
    if (conversation.title !== "New conversation" || this.messages.length > 1) return
    const title = text.replace(/\s+/g, " ").trim().slice(0, 64) || "New conversation"
    this.updateActive((item) => ({ ...item, title }))
    this.post({
      type: "conversations",
      conversations: this.conversationSummaries(),
      activeID: this.activeConversationID,
    })
  }

  private applyLocal(msg: Outbound) {
    switch (msg.type) {
      case "restore":
        this.messages = msg.messages.map((m) => ({ ...m, pending: false }))
        this.todos = msg.todos
        this.reviewHunks = msg.reviewHunks ?? {}
        return
      case "clear":
        this.messages = []
        this.todos = []
        this.reviewHunks = {}
        this.saveActive()
        return
      case "userMessage":
        this.messages = [
          ...this.messages,
          { id: msg.id, role: "user", blocks: [{ type: "text", text: msg.text }], ref: msg.ref },
        ]
        this.saveActive()
        return
      case "assistantStart":
        this.messages = [...this.messages, { id: msg.id, role: "assistant", blocks: [], pending: true }]
        this.saveActive()
        return
      case "textDelta":
        this.messages = appendText(this.messages, msg.id, "text", msg.delta)
        this.saveActive()
        return
      case "reasoningDelta":
        this.messages = appendText(this.messages, msg.id, "reasoning", msg.delta)
        this.saveActive()
        return
      case "tool":
        this.messages = upsertTool(this.messages, msg.id, msg.update)
        this.saveActive()
        return
      case "patch":
        this.messages = this.messages.map((m) =>
          m.id === msg.id ? { ...m, blocks: [...m.blocks, { type: "patch", files: msg.files, diff: msg.diff }] } : m,
        )
        this.saveActive()
        return
      case "todos":
        this.todos = msg.todos
        this.saveActive()
        return
      case "reviewHunkState":
        this.reviewHunks = { ...this.reviewHunks }
        if (msg.state) this.reviewHunks[msg.key] = msg.state
        else delete this.reviewHunks[msg.key]
        this.saveActive()
        return
      case "assistantError":
        this.messages = this.messages.map((m) =>
          m.id === msg.id ? { ...m, error: msg.message, pending: false } : m,
        )
        this.saveActive()
        return
      case "assistantDone":
        this.messages = this.messages.map((m) =>
          m.id === msg.id ? { ...m, pending: false, usage: msg.usage } : m,
        )
        this.saveActive()
        return
      case "aborted":
      case "sessionIdle":
        this.messages = this.messages.map((m) =>
          m.role === "assistant" && m.pending ? { ...m, pending: false } : m,
        )
        this.saveActive()
        return
    }
  }

  private postSelection() {
    const sel = this.prefs.get()
    const selection: Selection = {
      agent: sel.agent,
      model: sel.modelProviderID && sel.modelID ? `${sel.modelProviderID}/${sel.modelID}` : undefined,
    }
    this.post({ type: "selection", selection })
  }

  private pushContext() {
    const ctx = getEditorContext()
    const label = formatContextHeader(ctx)
    this.post({ type: "context", ref: { path: ctx.filePath, label } })
  }

  private async onMessage(msg: Inbound) {
    switch (msg.type) {
      case "mounted": {
        const sel = this.prefs.get()
        this.post({
          type: "ready",
          connected: false,
          selection: {
            agent: sel.agent,
            model: sel.modelProviderID && sel.modelID ? `${sel.modelProviderID}/${sel.modelID}` : undefined,
          },
        })
        this.sendConversationState()
        this.pushContext()
        try {
          await this.servers.ensure()
          this.post({ type: "connected", connected: true })
        } catch (e) {
          this.post({ type: "connected", connected: false, error: (e as Error).message })
        }
        return
      }
      case "send":
        await this.handleSend(msg.text)
        return
      case "abort":
        await this.abortCurrent()
        return
      case "newSession":
        await this.newSession()
        return
      case "createConversation":
        await this.createConversation()
        return
      case "selectConversation":
        await this.pickConversation()
        return
      case "openConversation":
        await this.selectConversation(msg.id)
        return
      case "renameConversation":
        await this.renameConversation(msg.id, msg.title)
        return
      case "deleteConversation":
        await this.deleteConversation(msg.id)
        return
      case "apply":
        await applyCode(msg.code, msg.language)
        return
      case "openFile":
        await openFile(msg.path)
        return
      case "openReviewChange":
        this.openReviewChange(msg.change)
        return
      case "reviewHunk":
        this.post({
          type: "reviewHunkState",
          key: msg.key,
          state: await reviewHunk(msg.path, msg.action, msg.oldText, msg.newText) ? msg.action : undefined,
        })
        return
      case "selectAgent":
        await vscode.commands.executeCommand("opencui.selectAgent")
        return
      case "selectModel":
        await vscode.commands.executeCommand("opencui.selectModel")
        return
      case "permissionReply": {
        this.activePermissions.delete(msg.id)
        if (!this.sessionID) return
        try {
          const backend = await this.servers.ensure()
          await backend.client.postSessionIdPermissionsPermissionId({
            path: { id: this.sessionID, permissionID: msg.id },
            body: { response: msg.response },
          })
        } catch (e) {
          log("permission reply failed", e)
        }
        return
      }
    }
  }

  private async abortCurrent() {
    if (!this.sessionID) return
    this.post({ type: "aborted" })
    try {
      const backend = await this.servers.ensure()
      await backend.client.session.abort({ path: { id: this.sessionID } })
    } catch (e) {
      log("session.abort failed", e)
    }
    // Do NOT close SSE — opencode will emit the final events telling us the
    // assistant message ended.
  }

  private async handleSend(text: string) {
    const ctx = getEditorContext()
    const label = formatContextHeader(ctx)
    this.post({
      type: "userMessage",
      id: "u_" + Date.now(),
      text,
      ref: { path: ctx.filePath, label },
    })
    this.updateTitleFromPrompt(text)

    let backend: Backend
    try {
      backend = await this.servers.ensure()
    } catch (e) {
      this.post({ type: "connected", connected: false, error: (e as Error).message })
      return
    }

    if (!this.sessionID) {
      const created = await backend.client.session.create({ body: {} })
      if (created.error || !created.data) {
        log("session.create failed", created.error)
        return
      }
      this.sessionID = created.data.id
      this.updateActive((conversation) => ({ ...conversation, sessionID: this.sessionID }))
      log("created session", this.sessionID)
      await this.attachSubscription(backend, this.sessionID)
    } else if (!this.subscription) {
      await this.attachSubscription(backend, this.sessionID)
    }

    const sel = this.prefs.get()
    const body: Parameters<typeof backend.client.session.prompt>[0]["body"] = {
      parts: [{ type: "text", text: buildPrompt(text, ctx) }],
    }
    if (sel.agent) body!.agent = sel.agent
    if (sel.modelProviderID && sel.modelID) {
      body!.model = { providerID: sel.modelProviderID, modelID: sel.modelID }
    }
    log("prompt dispatch", {
      sessionID: this.sessionID,
      agent: sel.agent ?? "default",
      model: sel.modelProviderID && sel.modelID ? `${sel.modelProviderID}/${sel.modelID}` : "default",
    })
    try {
      const res = await backend.client.session.promptAsync({
        path: { id: this.sessionID },
        body,
      })
      if (res.error) {
        log("prompt failed", res.error)
      }
    } catch (e) {
      log("prompt call threw", e)
    }
    // No UI action here — the SSE subscription owns assistant lifecycle.
  }

  private async attachSubscription(backend: Backend, sessionID: string) {
    this.subscription?.abort()
    this.subscription = subscribeSession(backend, sessionID, {
      onAssistantStart: (mid) => {
        const webviewID = "a_" + mid
        this.messageMap.set(mid, webviewID)
        this.post({ type: "assistantStart", id: webviewID })
      },
      onAssistantEnd: (mid, payload) => {
        const webviewID = this.messageMap.get(mid)
        if (!webviewID) return
        if (payload.error) {
          this.post({ type: "assistantError", id: webviewID, message: payload.error })
        }
        this.post({ type: "assistantDone", id: webviewID, usage: payload.usage })
      },
      onTextDelta: (mid, delta) => {
        const webviewID = this.messageMap.get(mid) ?? this.ensureWebviewID(mid)
        this.post({ type: "textDelta", id: webviewID, delta })
      },
      onReasoningDelta: (mid, delta) => {
        const webviewID = this.messageMap.get(mid) ?? this.ensureWebviewID(mid)
        this.post({ type: "reasoningDelta", id: webviewID, delta })
      },
      onTool: (mid, update) => {
        const webviewID = this.messageMap.get(mid) ?? this.ensureWebviewID(mid)
        const wire = toWire(update, backend.directory)
        this.post({ type: "tool", id: webviewID, update: wire })
        if (update.tool === "todowrite" && update.status !== "pending") {
          const todos = (update.input?.todos ?? []) as Todo[]
          if (todos.length) this.post({ type: "todos", todos })
        }
      },
      onPatch: (mid, files, diff) => {
        const webviewID = this.messageMap.get(mid) ?? this.ensureWebviewID(mid)
        this.post({
          type: "patch",
          id: webviewID,
          files: files.map((f) => relative(backend.directory, f)),
          diff,
        })
      },
      onPermissionNeeded: (perm) => {
        this.activePermissions.set(perm.id, perm)
        this.post({
          type: "permission",
          id: perm.id,
          title: perm.title,
          pattern: perm.pattern,
        })
      },
      onSessionError: (message) => {
        log("session error", message)
      },
      onSessionBusy: () => {
        this.post({ type: "sessionBusy" })
      },
      onSessionIdle: () => {
        this.post({ type: "sessionIdle" })
      },
    })
    try {
      await this.subscription.ready
    } catch {
      // error already surfaced via handler
    }
  }

  private ensureWebviewID(opencodeID: string): string {
    const existing = this.messageMap.get(opencodeID)
    if (existing) return existing
    const webviewID = "a_" + opencodeID
    this.messageMap.set(opencodeID, webviewID)
    this.post({ type: "assistantStart", id: webviewID })
    return webviewID
  }

  private openReviewChange(change: ReviewChange) {
    this.reviewChange = change
    if (!this.reviewPanel) {
      this.reviewPanel = vscode.window.createWebviewPanel(
        "opencui.reviewChange",
        "Review change",
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
      )
      this.reviewPanel.onDidDispose(() => {
        this.reviewPanel = undefined
        this.reviewChange = undefined
      })
      this.reviewPanel.webview.onDidReceiveMessage((msg) => this.onReviewPanelMessage(msg))
    }
    this.refreshReviewPanel()
    this.reviewPanel.reveal(vscode.ViewColumn.One)
  }

  private async onReviewPanelMessage(msg: { type?: string; key?: string; path?: string; action?: ReviewHunkState; oldText?: string; newText?: string }) {
    if (msg.type !== "reviewHunk" || !msg.key || !msg.path || !msg.action) return
    const state = await reviewHunk(msg.path, msg.action, msg.oldText ?? "", msg.newText ?? "") ? msg.action : undefined
    this.post({ type: "reviewHunkState", key: msg.key, state })
    if (!state || !this.reviewChange) {
      this.refreshReviewPanel()
      return
    }
    const nextReviewed = { ...this.reviewHunks, [msg.key]: state }
    if (hasPendingReviewHunks(this.reviewChange, nextReviewed)) {
      this.refreshReviewPanel(nextReviewed)
      return
    }
    this.reviewPanel?.dispose()
    await openFile(msg.path)
  }

  private refreshReviewPanel(reviewed = this.reviewHunks) {
    if (!this.reviewPanel || !this.reviewChange) return
    this.reviewPanel.title = path.basename(this.reviewChange.path)
    this.reviewPanel.webview.html = reviewChangeHtml(this.reviewChange, reviewed)
  }

  private async buildHtml(webview: vscode.Webview): Promise<string> {
    const htmlUri = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "index.html")
    const bytes = await vscode.workspace.fs.readFile(htmlUri)
    let html = Buffer.from(bytes).toString("utf8")
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource}`,
      `img-src ${webview.cspSource} https: data: blob:`,
      `font-src ${webview.cspSource} data:`,
      `connect-src data: blob:`,
      `worker-src blob:`,
    ].join("; ")
    html = html.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
    return html
  }
}

function appendText(
  messages: ChatMessage[],
  id: string,
  kind: "text" | "reasoning",
  delta: string,
): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== id) return message
    const last = message.blocks[message.blocks.length - 1]
    if (last?.type === kind) {
      return {
        ...message,
        blocks: [...message.blocks.slice(0, -1), { type: kind, text: last.text + delta }],
      }
    }
    return { ...message, blocks: [...message.blocks, { type: kind, text: delta }] }
  })
}

function upsertTool(messages: ChatMessage[], id: string, update: WireToolUpdate): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== id) return message
    const existing = message.blocks.findIndex((b) => b.type === "tool" && b.update.callID === update.callID)
    if (existing >= 0) {
      const blocks = message.blocks.slice()
      blocks[existing] = { type: "tool", update }
      return { ...message, blocks }
    }
    return { ...message, blocks: [...message.blocks, { type: "tool", update }] }
  })
}

function buildPrompt(userText: string, ctx: ReturnType<typeof getEditorContext>): string {
  const lines: string[] = []
  if (ctx.relativePath) {
    lines.push(`Context: ${ctx.relativePath}`)
    if (ctx.selection) {
      lines.push(`Selection (lines ${ctx.selection.startLine}-${ctx.selection.endLine}):`)
      lines.push("```" + (ctx.language ?? ""))
      lines.push(ctx.selection.text)
      lines.push("```")
    }
    lines.push("")
  }
  lines.push(userText)
  return lines.join("\n")
}

function toWire(update: ToolUpdate, cwd: string): WireToolUpdate {
  const input = update.input ? { ...update.input } : undefined
  if (input) {
    if (typeof input.filePath === "string") input.filePath = relative(cwd, input.filePath)
    if (typeof input.path === "string") input.path = relative(cwd, input.path)
  }
  return {
    callID: update.callID,
    tool: update.tool,
    status: update.status,
    title: update.title,
    input,
    metadata: update.metadata,
    output: update.output,
    error: update.error,
  }
}

function relative(cwd: string, p: string): string {
  if (!p) return p
  if (!path.isAbsolute(p)) return p
  const rel = path.relative(cwd, p)
  return rel && !rel.startsWith("..") ? rel : p
}

async function applyCode(code: string, _language?: string) {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showWarningMessage("OpenCUI: open a file first to apply")
    return
  }
  const doc = editor.document
  const target = editor.selection.isEmpty
    ? new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
    : editor.selection
  const proposedUri = vscode.Uri.parse(`untitled:OpenCUI-apply-${Date.now()}.${doc.languageId}`)
  await vscode.workspace.openTextDocument(proposedUri)
  const insert = new vscode.WorkspaceEdit()
  insert.insert(proposedUri, new vscode.Position(0, 0), code)
  await vscode.workspace.applyEdit(insert)
  await vscode.commands.executeCommand("vscode.diff", doc.uri, proposedUri, "OpenCUI: Apply preview")
  const choice = await vscode.window.showInformationMessage(
    "Apply this change?",
    { modal: false },
    "Apply",
    "Cancel",
  )
  if (choice !== "Apply") return
  const edit = new vscode.WorkspaceEdit()
  edit.replace(doc.uri, target, code)
  await vscode.workspace.applyEdit(edit)
}

async function openFile(relPath: string) {
  const ws = vscode.workspace.workspaceFolders?.[0]
  if (!ws) return
  const uri = path.isAbsolute(relPath) ? vscode.Uri.file(relPath) : vscode.Uri.joinPath(ws.uri, relPath)
  const doc = await vscode.workspace.openTextDocument(uri)
  await vscode.window.showTextDocument(doc)
}

type ReviewDiffLine = {
  text: string
  kind: "add" | "del" | "hunk" | "ctx"
}

type ReviewDiffHunk = {
  id: string
  header: string
  lines: ReviewDiffLine[]
  oldText: string
  newText: string
  reversible: boolean
}

function reviewChangeHtml(change: ReviewChange, reviewed: Record<string, ReviewHunkState>): string {
  const diff = splitReviewDiff(change.patch)
  const pending = diff.hunks
    .map((hunk) => ({ ...hunk, key: reviewKey(change, hunk.id) }))
    .filter((hunk) => !reviewed[hunk.key])
  const payload = JSON.stringify(pending.map(({ key, oldText, newText, reversible }) => ({ key, oldText, newText, reversible }))).replace(/</g, "\\u003c")
  const body = pending.length
    ? pending.map((hunk) => `
      <section class="hunk" data-key="${escapeHtml(hunk.key)}">
        <div class="hunk-head">
          <button class="action accept" data-action="accepted" data-key="${escapeHtml(hunk.key)}">Accept</button>
          <button class="action reject" data-action="rejected" data-key="${escapeHtml(hunk.key)}"${hunk.reversible ? "" : " disabled title=\"This patch format cannot be rejected as a hunk\""}>Reject</button>
        </div>
        <pre class="code"><code>${hunk.lines.map(diffLineHtml).join("")}</code></pre>
      </section>
    `).join("")
    : `<div class="empty">All hunks in this file have been reviewed.</div>`

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .top {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      padding: 10px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .title {
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-weight: 650;
    }
    .stats {
      flex: 0 0 auto;
      margin-left: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
    .add { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
    .del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
    main { padding: 12px 14px 24px; }
    .hunk {
      margin: 0 0 14px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-textCodeBlock-background);
    }
    .hunk-head {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      padding: 7px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
    }
    .action {
      flex: 0 0 auto;
      min-width: 64px;
      padding: 3px 9px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .action:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    .action.accept { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
    .action.reject { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
    .action:disabled { cursor: default; opacity: 0.55; }
    .code {
      margin: 0;
      padding: 0;
      overflow: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.45;
    }
    .line {
      display: block;
      min-height: 1.45em;
      padding: 0 12px;
      white-space: pre;
    }
    .line.add {
      color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
      background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #3fb950) 14%, transparent);
    }
    .line.del {
      color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
      background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f85149) 14%, transparent);
    }
    .line.hunk {
      color: var(--vscode-textLink-foreground);
      background: var(--vscode-editor-lineHighlightBackground);
    }
    .empty {
      padding: 24px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="top">
    <span class="title" title="${escapeHtml(change.path)}">${escapeHtml(change.path)}</span>
    <span class="stats"><span class="add">+${change.additions}</span> <span class="del">-${change.deletions}</span></span>
  </div>
  <main>${body}</main>
  <script>
    const vscode = acquireVsCodeApi();
    const hunks = new Map(${payload}.map((hunk) => [hunk.key, hunk]));
    document.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-key]");
      if (!button) return;
      const hunk = hunks.get(button.dataset.key);
      if (!hunk) return;
      if (button.dataset.action === "rejected" && !hunk.reversible) return;
      button.closest(".hunk")?.querySelectorAll("button").forEach((item) => item.disabled = true);
      vscode.postMessage({
        type: "reviewHunk",
        key: hunk.key,
        path: ${JSON.stringify(change.path)},
        action: button.dataset.action,
        oldText: hunk.oldText,
        newText: hunk.newText
      });
    });
  </script>
</body>
</html>`
}

function splitReviewDiff(patch: string): { hunks: ReviewDiffHunk[] } {
  const lines = patch.split("\n")
  const hunks: ReviewDiffHunk[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (!line.startsWith("@@")) {
      index += 1
      continue
    }

    const hunkHeader = line
    const hunkLines: string[] = []
    index += 1
    while (index < lines.length && !(lines[index] ?? "").startsWith("@@")) {
      hunkLines.push(lines[index] ?? "")
      index += 1
    }

    const { oldText, newText } = hunkText(hunkLines)
    hunks.push({
      id: `${hunks.length}-${hunkHeader}`,
      header: hunkHeader,
      lines: diffLines(hunkLines.join("\n")),
      oldText,
      newText,
      reversible: true,
    })
  }

  if (!hunks.length && patch.trim()) {
    hunks.push({
      id: "0-file",
      header: "@@ file change @@",
      lines: diffLines(patch),
      oldText: "",
      newText: "",
      reversible: false,
    })
  }

  return { hunks }
}

function hunkText(lines: string[]) {
  const oldLines: string[] = []
  const newLines: string[] = []
  for (const line of lines) {
    if (line.startsWith("\\ No newline")) continue
    if (line.startsWith("+") && !line.startsWith("+++")) {
      newLines.push(line.slice(1))
      continue
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      oldLines.push(line.slice(1))
      continue
    }
    const text = line.startsWith(" ") ? line.slice(1) : line
    oldLines.push(text)
    newLines.push(text)
  }
  return {
    oldText: oldLines.join("\n"),
    newText: newLines.join("\n"),
  }
}

function diffLines(patch: string) {
  return patch.split("\n").map((text) => ({
    text,
    kind: text.startsWith("+") && !text.startsWith("+++") ? "add" : text.startsWith("-") && !text.startsWith("---") ? "del" : text.startsWith("@@") ? "hunk" : "ctx",
  } satisfies ReviewDiffLine))
}

function diffLineHtml(line: ReviewDiffLine) {
  return `<span class="line ${line.kind}">${escapeHtml(line.text || " ")}</span>`
}

function hasPendingReviewHunks(change: ReviewChange, reviewed: Record<string, ReviewHunkState>) {
  return splitReviewDiff(change.patch).hunks.some((hunk) => !reviewed[reviewKey(change, hunk.id)])
}

function reviewKey(change: ReviewChange, hunkID: string) {
  return `${change.source}:${normalizePath(change.path)}:${hunkID}`
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "")
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

async function reviewHunk(relPath: string, action: ReviewHunkState, oldText: string, newText: string): Promise<boolean> {
  if (action === "accepted") return true
  const ws = vscode.workspace.workspaceFolders?.[0]
  if (!ws) return false
  const uri = path.isAbsolute(relPath) ? vscode.Uri.file(relPath) : vscode.Uri.joinPath(ws.uri, relPath)
  const doc = await vscode.workspace.openTextDocument(uri)
  const current = doc.getText()
  const match = findHunkText(current, newText)
  if (!match) {
    vscode.window.showWarningMessage(`OpenCUI: could not reject hunk in ${relPath}; the file changed since the diff was generated.`)
    await vscode.window.showTextDocument(doc)
    return false
  }
  const edit = new vscode.WorkspaceEdit()
  edit.replace(uri, new vscode.Range(doc.positionAt(match.start), doc.positionAt(match.end)), oldText)
  const ok = await vscode.workspace.applyEdit(edit)
  if (!ok) {
    vscode.window.showWarningMessage(`OpenCUI: could not reject hunk in ${relPath}`)
    return false
  }
  await vscode.window.showTextDocument(doc)
  return true
}

function findHunkText(current: string, value: string): { start: number; end: number } | undefined {
  const candidates = unique([
    value,
    value.endsWith("\n") ? value.slice(0, -1) : `${value}\n`,
    value.replace(/\r?\n/g, "\r\n"),
  ]).filter((candidate) => candidate.length > 0)
  for (const candidate of candidates) {
    const start = current.indexOf(candidate)
    if (start >= 0) return { start, end: start + candidate.length }
  }
  if (value.length === 0) return { start: 0, end: 0 }
  return undefined
}

function unique(items: string[]) {
  return [...new Set(items)]
}

function fallbackHtml(message: string): string {
  return `<!doctype html><html><body style="padding:20px;font-family:sans-serif;">
    <h2>OpenCUI</h2><p>${message}</p></body></html>`
}
