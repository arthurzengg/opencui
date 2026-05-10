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
  ToolUpdate as WireToolUpdate,
  Selection,
  ReviewChange,
  ReviewHunkState,
} from "../protocol"

const CONVERSATIONS_KEY = "opencui.conversations"
const ACTIVE_CONVERSATION_KEY = "opencui.activeConversation"
const MIGRATED_TO_WORKSPACE_KEY = "opencui.migratedToWorkspaceState"

type SavedConversation = ConversationSummary & {
  createdAt: number
  sessionID?: string
  messages: ChatMessage[]
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
  /** Webview ID of the user message currently awaiting a backend ID from the stream. */
  private pendingUserBackendID?: string
  private reviewHunks: Record<string, ReviewHunkState> = {}
  private reviewPanel?: vscode.WebviewPanel
  private reviewChange?: ReviewChange

  constructor(
    private context: vscode.ExtensionContext,
    private servers: ServerManager,
    private prefs: Preferences,
  ) {
    migrateConversationsToWorkspace(context)
    this.conversations = context.workspaceState.get<SavedConversation[]>(CONVERSATIONS_KEY) ?? []
    this.activeConversationID = context.workspaceState.get<string>(ACTIVE_CONVERSATION_KEY) ?? ""
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

    vscode.window.onDidChangeActiveTextEditor(() => {
      this.pushContext()
      this.queueReviewDecorationsSync()
    }, null, this.context.subscriptions)
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
    await this.context.workspaceState.update(CONVERSATIONS_KEY, this.conversations)
    await this.context.workspaceState.update(ACTIVE_CONVERSATION_KEY, this.activeConversationID)
  }

  private saveActive() {
    this.updateActive((conversation) => ({
      ...conversation,
      sessionID: this.sessionID,
      messages: this.messages,
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
        this.reviewHunks = msg.reviewHunks ?? {}
        this.queueReviewDecorationsSync()
        return
      case "clear":
        this.messages = []
        this.reviewHunks = {}
        this.saveActive()
        return
      case "userMessage":
        this.messages = [
          ...this.messages,
          { id: msg.id, role: "user", blocks: [{ type: "text", text: msg.text }], ref: msg.ref, backendID: msg.backendID },
        ]
        this.saveActive()
        return
      case "userMessageBackendID":
        this.messages = this.messages.map((m) =>
          m.id === msg.id ? { ...m, backendID: msg.backendID } : m,
        )
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
        this.queueReviewDecorationsSync()
        return
      case "patch":
        this.messages = this.messages.map((m) =>
          m.id === msg.id ? { ...m, blocks: [...m.blocks, { type: "patch", files: msg.files, diff: msg.diff }] } : m,
        )
        this.saveActive()
        this.queueReviewDecorationsSync()
        return
      case "reviewHunkState":
        this.reviewHunks = { ...this.reviewHunks }
        if (msg.state) this.reviewHunks[msg.key] = msg.state
        else delete this.reviewHunks[msg.key]
        this.saveActive()
        this.queueReviewDecorationsSync()
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
      case "editMessage":
        await this.handleEdit(msg.id, msg.text)
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
        void this.openReviewChange(msg.change)
        return
      case "reviewHunk":
        this.post({
          type: "reviewHunkState",
          key: msg.key,
          state: await reviewHunk(msg.path, msg.action, msg.oldText, msg.newText) ? msg.action : undefined,
        })
        return
      case "reviewAllInChange":
        await this.handleReviewAllInChange(msg.source, msg.path, msg.action)
        return
      case "selectAgent":
        log("selectAgent → executing opencui.selectAgent")
        await vscode.commands.executeCommand("opencui.selectAgent")
        return
      case "selectModel":
        log("selectModel → executing opencui.selectModel")
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
    const userMessageID = "u_" + Date.now()
    this.pendingUserBackendID = userMessageID
    this.post({
      type: "userMessage",
      id: userMessageID,
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

  private async handleEdit(webviewID: string, text: string) {
    const target = this.messages.find((m) => m.id === webviewID && m.role === "user")
    if (!target) {
      log("editMessage: user message not found", webviewID)
      return
    }
    const trimmed = text.trim()
    if (!trimmed) return

    if (target.backendID && this.sessionID) {
      try {
        const backend = await this.servers.ensure()
        const res = await backend.client.session.revert({
          path: { id: this.sessionID },
          body: { messageID: target.backendID },
        })
        if (res.error) log("session.revert failed", res.error)
      } catch (e) {
        log("session.revert threw", e)
      }
    } else {
      log("editMessage: no backendID — truncating locally only", webviewID)
    }

    const idx = this.messages.findIndex((m) => m.id === webviewID)
    if (idx >= 0) {
      this.messages = this.messages.slice(0, idx)
      this.reviewHunks = {}
      this.saveActive()
      this.sendConversationState()
      this.queueReviewDecorationsSync()
    }

    await this.handleSend(trimmed)
  }

  private async attachSubscription(backend: Backend, sessionID: string) {
    this.subscription?.abort()
    this.subscription = subscribeSession(backend, sessionID, {
      onUserMessage: (mid) => {
        const targetID = this.pendingUserBackendID
        if (!targetID) return
        const target = this.messages.find((m) => m.id === targetID)
        if (!target || target.backendID) return
        this.pendingUserBackendID = undefined
        this.post({ type: "userMessageBackendID", id: targetID, backendID: mid })
      },
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

  private async openReviewChange(change: ReviewChange) {
    if (!isTextReviewPath(change.path)) {
      vscode.window.showWarningMessage(`OpenCUI: ${change.path} cannot be reviewed as text.`)
      return
    }
    this.reviewChange = change
    this.reviewPanel?.dispose()
    this.reviewPanel = undefined
    try {
      const doc = await openFileDocument(change.path)
      await this.syncReviewDecorations()
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false })
    } catch (e) {
      log(`could not open review file ${change.path}`, e)
      vscode.window.showWarningMessage(`OpenCUI: could not open ${change.path} as text.`)
    }
  }

  private async purgeMissingFileHunks(changes: ReviewChange[]): Promise<void> {
    const seen = new Set<string>()
    for (const change of changes) {
      if (seen.has(change.path)) continue
      seen.add(change.path)
      // Never purge created files — they were just written and may not yet be
      // visible to the VS Code file-system API, or the workspace may not cover
      // the path. Purging here would permanently hide the review card.
      if (change.kind === "created") continue
      if (await reviewPathExists(change.path)) continue
      let purged = 0
      for (const sibling of changes) {
        if (!samePath(sibling.path, change.path)) continue
        for (const hunk of splitReviewDiff(sibling.patch).hunks) {
          const key = reviewKey(sibling, hunk.id)
          if (this.reviewHunks[key]) continue
          this.post({ type: "reviewHunkState", key, state: "rejected" })
          purged += 1
        }
      }
      if (purged) log(`purged ${purged} review hunks for missing file ${change.path}`)
    }
  }

  private async handleReviewAllInChange(source: string, requestedPath: string, action: ReviewHunkState) {
    const all = reviewChanges(this.messages)
    // Match every change for this path, not just the one matching `source`.
    // A single physical edit can show up as multiple ReviewChange records
    // (tool block + patch block of the same hunk produce different sources
    // and therefore different reviewKeys). If we only mark the source-matched
    // record's hunks reviewed, the other record's hunks still spawn codelenses
    // and decorations on the next sync. For reject this is masked because the
    // file actually changes and the duplicate hunks become unlocatable; for
    // accept the file is unchanged, so duplicates would linger forever.
    const targets = all.filter((c) => samePath(c.path, requestedPath))
    if (!targets.length) {
      log("reviewAllInChange: no matching change", { source, path: requestedPath, available: all.map((c) => ({ source: c.source, path: c.path })) })
      return
    }
    // If the file no longer exists on disk, neither accept nor reject can
    // operate on it — silently mark every pending hunk reviewed so the row
    // drops out of the Review Card and tell the user once.
    if (!(await reviewPathExists(requestedPath))) {
      let purged = 0
      for (const change of targets) {
        for (const hunk of splitReviewDiff(change.patch).hunks) {
          const key = reviewKey(change, hunk.id)
          if (this.reviewHunks[key]) continue
          this.post({ type: "reviewHunkState", key, state: "rejected" })
          purged += 1
        }
      }
      vscode.window.showInformationMessage(
        `OpenCUI: ${requestedPath} is no longer present; removed ${purged} pending hunk${purged === 1 ? "" : "s"} from review.`,
      )
      await this.syncReviewDecorations()
      return
    }
    let any = false
    for (const change of targets) {
      const hunks = splitReviewDiff(change.patch).hunks
      for (const hunk of hunks) {
        const key = reviewKey(change, hunk.id)
        if (this.reviewHunks[key]) continue
        if (action === "rejected" && !hunk.reversible) continue
        const ok = await reviewHunk(change.path, action, hunk.oldText, hunk.newText, true)
        if (ok) {
          this.post({ type: "reviewHunkState", key, state: action })
          any = true
          continue
        }
        // For reject, the first change in `targets` may have already reverted
        // the file — subsequent reviewHunk calls then fail to relocate newText.
        // Still mark the duplicate hunk as reviewed so its codelens clears.
        if (action === "rejected") {
          this.post({ type: "reviewHunkState", key, state: action })
          any = true
        }
      }
    }
    if (any) await this.syncReviewDecorations()
    else log("reviewAllInChange: no hunks applied", { source, path: requestedPath, action })
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

  private queueReviewDecorationsSync() {
    void this.syncReviewDecorations().catch((e) => log("review decorations sync failed", e))
  }

  private async syncReviewDecorations() {
    // All editor-side review UI (line highlights, ghost-text deletions,
    // unlocatable banner) was removed — review actions live exclusively in
    // the Review Card now. This sync only purges hunks for files that have
    // been deleted on disk so they don't linger in the panel.
    const changes = reviewChanges(this.messages).filter((change) => isTextReviewPath(change.path))
    if (!changes.length) return
    await this.purgeMissingFileHunks(changes)
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

/**
 * One-shot copy of conversation data from the legacy global storage into the
 * current workspace's state. Runs once per workspace; subsequent activations
 * see the migrated data already in workspaceState and skip the copy.
 *
 * Existing global storage keys are cleared after the first successful migration
 * so a different workspace doesn't see the same conversations duplicated.
 */
function migrateConversationsToWorkspace(context: vscode.ExtensionContext) {
  if (context.workspaceState.get<boolean>(MIGRATED_TO_WORKSPACE_KEY, false)) return
  const legacy = context.globalState.get<SavedConversation[]>(CONVERSATIONS_KEY)
  if (legacy && legacy.length) {
    void context.workspaceState.update(CONVERSATIONS_KEY, legacy)
    const legacyActive = context.globalState.get<string>(ACTIVE_CONVERSATION_KEY)
    if (legacyActive) void context.workspaceState.update(ACTIVE_CONVERSATION_KEY, legacyActive)
    void context.globalState.update(CONVERSATIONS_KEY, undefined)
    void context.globalState.update(ACTIVE_CONVERSATION_KEY, undefined)
  }
  void context.workspaceState.update(MIGRATED_TO_WORKSPACE_KEY, true)
}

function reviewChanges(messages: ChatMessage[]) {
  const changes = messages.flatMap((message) =>
    message.blocks.flatMap((block, blockIndex) => {
      const source = `${message.id}:${blockIndex}`
      if (block.type === "patch" && block.diff) return diffChanges(block.diff, source)
      if (block.type !== "tool" || block.update.status !== "completed") return []
      return toolChanges(block.update, block.update.callID || source)
    }),
  )
  return changes.reduce<ReviewChange[]>((acc, change) => {
    const existing = acc.findIndex((item) => (
      samePath(item.path, change.path) && (item.source === change.source || item.patch === change.patch)
    ))
    if (existing < 0) return [...acc, change]
    const copy = acc.slice()
    copy[existing] = change
    return copy
  }, [])
}

function toolChanges(update: WireToolUpdate, source: string) {
  if (update.tool === "apply_patch") return patchChanges(update.metadata?.files, source)
  const filediff = isRecord(update.metadata?.filediff) ? update.metadata.filediff : undefined
  let patch = typeof filediff?.patch === "string" ? filediff.patch : typeof update.metadata?.diff === "string" ? update.metadata.diff : undefined
  const isCreate =
    (update.tool === "write" && update.metadata?.exists === false) ||
    (update.tool === "edit" && update.input?.oldString === "")
  if (!patch && isCreate) patch = synthesizeCreatePatch(update)
  if (!patch) return []
  return [{
    source,
    path: displayPath(update, filediff),
    kind: isCreate ? "created" : "updated",
    additions: typeof filediff?.additions === "number" ? filediff.additions : countDiff(patch, "+"),
    deletions: typeof filediff?.deletions === "number" ? filediff.deletions : countDiff(patch, "-"),
    patch,
  } satisfies ReviewChange]
}

function synthesizeCreatePatch(update: WireToolUpdate): string | undefined {
  const content =
    update.tool === "write" && typeof update.input?.content === "string"
      ? update.input.content
      : update.tool === "edit" && typeof update.input?.newString === "string"
        ? update.input.newString
        : undefined
  if (typeof content !== "string") return undefined
  const lines = content.split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  if (!lines.length) return undefined
  const body = lines.map((line) => `+${line}`).join("\n")
  return `@@ -0,0 +1,${lines.length} @@\n${body}`
}

function patchChanges(files: unknown, source: string) {
  if (!Array.isArray(files)) return []
  return files.flatMap((file) => {
    if (!isRecord(file) || typeof file.relativePath !== "string" || typeof file.patch !== "string") return []
    return [{
      source: `${source}:${file.relativePath}`,
      path: file.relativePath,
      kind: patchKind(file.type),
      additions: typeof file.additions === "number" ? file.additions : countDiff(file.patch, "+"),
      deletions: typeof file.deletions === "number" ? file.deletions : countDiff(file.patch, "-"),
      patch: file.patch,
    } satisfies ReviewChange]
  })
}

function diffChanges(diff: string, source: string) {
  const starts = diff.split("\n").reduce<number[]>((acc, line, index) => (
    line.startsWith("diff --git ") ? [...acc, index] : acc
  ), [])
  if (!starts.length) return createPatchChange(diff, source)
  const lines = diff.split("\n")
  return starts.map((start, index) => {
    const chunk = lines.slice(start, starts[index + 1] ?? lines.length).join("\n")
    const header = lines[start] ?? ""
    const match = header.match(/^diff --git a\/(.+) b\/(.+)$/)
    const pathValue = match?.[2] ?? match?.[1] ?? patchPath(chunk)
    return {
      source: `${source}:${index}`,
      path: pathValue,
      kind: chunk.includes("\nnew file mode ") ? "created" : chunk.includes("\ndeleted file mode ") ? "deleted" : "updated",
      additions: countDiff(chunk, "+"),
      deletions: countDiff(chunk, "-"),
      patch: chunk,
    } satisfies ReviewChange
  })
}

function createPatchChange(patch: string, source: string) {
  return [{
    source,
    path: patchPath(patch),
    kind: patch.includes("\n--- /dev/null") ? "created" : patch.includes("\n+++ /dev/null") ? "deleted" : "updated",
    additions: countDiff(patch, "+"),
    deletions: countDiff(patch, "-"),
    patch,
  } satisfies ReviewChange]
}

function patchPath(patch: string) {
  const plus = patch.match(/\n\+\+\+\s+(?:b\/)?(.+)/)?.[1]
  if (plus && plus !== "/dev/null") return plus
  const minus = patch.match(/\n---\s+(?:a\/)?(.+)/)?.[1]
  if (minus && minus !== "/dev/null") return minus
  const index = patch.match(/^Index:\s+(.+)$/m)?.[1]
  return index ?? "file"
}

function displayPath(update: { title?: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> }, filediff?: Record<string, unknown>) {
  // The absolute filepath opencode resolved is unambiguous; prefer it. The
  // model's raw input.filePath can be relative to opencode's internal
  // directory (e.g., the git worktree root) which differs from our VSCode
  // workspace folder, and persisted conversations may already have the wrong
  // relative there.
  const fromMetadata = typeof update.metadata?.filepath === "string" ? update.metadata.filepath : undefined
  if (fromMetadata && path.isAbsolute(fromMetadata)) return fromMetadata
  const fromFilediff = typeof filediff?.file === "string" ? filediff.file : undefined
  if (fromFilediff && path.isAbsolute(fromFilediff)) return fromFilediff
  if (typeof update.input?.filePath === "string" && update.input.filePath) return update.input.filePath
  if (typeof update.title === "string" && update.title.trim()) return update.title
  return fromFilediff ?? "file"
}

function patchKind(value: unknown): ReviewChange["kind"] {
  if (value === "add") return "created"
  if (value === "delete") return "deleted"
  if (value === "move") return "moved"
  return "updated"
}

function samePath(left: string, right?: string) {
  if (!right) return false
  return normalizePath(left) === normalizePath(right)
}

async function reviewPathExists(relPath: string): Promise<boolean> {
  return !!(await existingWorkspaceFileUri(relPath))
}

function isTextReviewPath(value: string) {
  const name = path.basename(value).toLowerCase()
  if (!name || name === ".ds_store" || name === "thumbs.db") return false
  const ext = path.extname(name)
  if (!ext && name.startsWith(".")) return false
  const binaryExtensions = new Set([
    ".ai",
    ".avif",
    ".bin",
    ".bmp",
    ".class",
    ".db",
    ".dmg",
    ".doc",
    ".docx",
    ".ds_store",
    ".eot",
    ".exe",
    ".gif",
    ".heic",
    ".icns",
    ".ico",
    ".jar",
    ".jpeg",
    ".jpg",
    ".mov",
    ".mp3",
    ".mp4",
    ".otf",
    ".pdf",
    ".png",
    ".pyc",
    ".so",
    ".sqlite",
    ".ttf",
    ".webp",
    ".woff",
    ".woff2",
    ".zip",
  ])
  return !binaryExtensions.has(ext)
}

function countDiff(patch: string, prefix: "+" | "-") {
  return patch.split("\n").filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)).length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
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
  const metadata = update.metadata ? normalizeWireMetadata(update.metadata, cwd) : undefined
  if (input) {
    // Prefer the absolute filepath opencode resolved (in metadata) over the
    // raw model input. The raw input may be relative to opencode's internal
    // directory (e.g., the git worktree root) which differs from our VSCode
    // workspace folder, and a relative path here would be joined against the
    // wrong base when we open or stat the file.
    const resolved = pickResolvedPath(metadata)
    if (resolved && path.isAbsolute(resolved)) {
      input.filePath = relative(cwd, resolved)
    } else if (typeof input.filePath === "string") {
      input.filePath = relative(cwd, input.filePath)
    }
    if (typeof input.path === "string") input.path = relative(cwd, input.path)
  }
  return {
    callID: update.callID,
    tool: update.tool,
    status: update.status,
    title: update.title,
    input,
    metadata,
    output: update.output,
    error: update.error,
  }
}

function normalizeWireMetadata(metadata: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const next = { ...metadata }
  if (typeof next.filepath === "string" && !path.isAbsolute(next.filepath)) {
    next.filepath = relative(cwd, next.filepath)
  }
  if (isRecord(next.filediff)) {
    const filediff = { ...next.filediff }
    if (typeof filediff.file === "string" && !path.isAbsolute(filediff.file)) {
      filediff.file = relative(cwd, filediff.file)
    }
    next.filediff = filediff
  }
  if (Array.isArray(next.files)) {
    next.files = next.files.map((file) => {
      if (!isRecord(file) || typeof file.relativePath !== "string") return file
      return { ...file, relativePath: relative(cwd, file.relativePath) }
    })
  }
  return next
}

function pickResolvedPath(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined
  if (typeof metadata.filepath === "string") return metadata.filepath
  const filediff = metadata.filediff
  if (isRecord(filediff) && typeof filediff.file === "string") return filediff.file
  return undefined
}

function relative(cwd: string, p: string): string {
  if (!p) return p
  if (!path.isAbsolute(p)) return stripWorkspaceFolderPrefix(cwd, p) ?? p
  const rel = path.relative(cwd, p)
  return rel && !rel.startsWith("..") ? rel : p
}

const SHELL_LANGS = new Set([
  "bash", "sh", "shell", "shellscript", "zsh", "fish", "powershell", "ps", "ps1", "bat", "cmd",
])

async function applyCode(code: string, language?: string) {
  // Shell snippets go to the integrated terminal — Apply on a `npm start`
  // block belongs in a terminal, not a file.
  if (language && SHELL_LANGS.has(language.toLowerCase())) {
    const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal({ name: "OpenCUI" })
    terminal.show(true)
    terminal.sendText(code.replace(/\n+$/, ""), true)
    return
  }
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showWarningMessage("OpenCUI: open a file first to apply this snippet")
    return
  }
  const doc = editor.document
  const target = editor.selection.isEmpty
    ? new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
    : editor.selection
  // Replace selection (or whole file) directly. Cmd+Z to revert.
  const edit = new vscode.WorkspaceEdit()
  edit.replace(doc.uri, target, code)
  await vscode.workspace.applyEdit(edit)
}

async function openFile(relPath: string) {
  const doc = await openFileDocument(relPath)
  await vscode.window.showTextDocument(doc)
}

async function openFileDocument(relPath: string) {
  const uri = await workspaceFileUri(relPath)
  return vscode.workspace.openTextDocument(uri)
}

function visibleReviewDocument(relPath: string) {
  const uris = new Set(workspaceFileUriCandidates(relPath).map(({ uri }) => uri.toString()))
  return vscode.window.visibleTextEditors.find((editor) => uris.has(editor.document.uri.toString()))?.document
}

async function workspaceFileUri(relPath: string) {
  const existing = await existingWorkspaceFileUri(relPath)
  if (existing) return existing
  const candidates = workspaceFileUriCandidates(relPath)
  return candidates.find((candidate) => candidate.preferIfMissing)?.uri ?? candidates[0]?.uri ?? vscode.Uri.file(relPath)
}

async function existingWorkspaceFileUri(relPath: string): Promise<vscode.Uri | undefined> {
  for (const { uri } of workspaceFileUriCandidates(relPath)) {
    try {
      await vscode.workspace.fs.stat(uri)
      return uri
    } catch {
      // Try the next plausible base.
    }
  }
  return undefined
}

function workspaceFileUriCandidates(relPath: string): Array<{ uri: vscode.Uri; preferIfMissing?: boolean }> {
  if (path.isAbsolute(relPath)) return [{ uri: vscode.Uri.file(relPath) }]
  const normalized = normalizeRelativeReviewPath(relPath)
  const workspaces = vscode.workspace.workspaceFolders ?? []
  if (!workspaces.length) return [{ uri: vscode.Uri.file(relPath) }]
  const candidates: Array<{ uri: vscode.Uri; preferIfMissing?: boolean }> = []
  const seen = new Set<string>()
  const add = (uri: vscode.Uri, preferIfMissing = false) => {
    const key = uri.toString()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ uri, preferIfMissing })
  }
  for (const ws of workspaces) {
    add(joinUriPath(ws.uri, normalized))
    const stripped = stripWorkspaceFolderPrefix(ws.uri.fsPath, normalized)
    if (stripped) add(joinUriPath(ws.uri, stripped), true)
  }
  return candidates
}

function joinUriPath(base: vscode.Uri, relPath: string) {
  return vscode.Uri.joinPath(base, ...relPath.split("/").filter(Boolean))
}

function normalizeRelativeReviewPath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "")
}

function stripWorkspaceFolderPrefix(workspacePath: string, relPath: string): string | undefined {
  const segments = normalizeRelativeReviewPath(relPath).split("/").filter(Boolean)
  if (segments.length < 2) return undefined
  if (segments[0].toLowerCase() !== path.basename(workspacePath).toLowerCase()) return undefined
  return segments.slice(1).join("/")
}

type ReviewDiffLine = {
  text: string
  kind: "add" | "del" | "hunk" | "ctx"
}

type ReviewDiffHunk = {
  id: string
  header: string
  lines: ReviewDiffLine[]
  anchorText: string
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
          <button class="action accept" data-action="accepted" data-key="${escapeHtml(hunk.key)}">Keep</button>
          <button class="action reject" data-action="rejected" data-key="${escapeHtml(hunk.key)}"${hunk.reversible ? "" : " disabled title=\"This patch format cannot be undone as a hunk\""}>Undo</button>
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

    const { oldText, newText, anchorText } = hunkText(hunkLines)
    hunks.push({
      id: `${hunks.length}-${hunkHeader}`,
      header: hunkHeader,
      lines: diffLines(hunkLines.join("\n")),
      anchorText,
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
      anchorText: firstReviewAnchor(diffLines(patch), patch),
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
  const diff = diffLines(lines.join("\n"))
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
    anchorText: firstReviewAnchor(diff, newLines.join("\n")),
  }
}

function diffLines(patch: string) {
  return patch.split("\n").map((text) => ({
    text,
    kind: text.startsWith("+") && !text.startsWith("+++") ? "add" : text.startsWith("-") && !text.startsWith("---") ? "del" : text.startsWith("@@") ? "hunk" : "ctx",
  } satisfies ReviewDiffLine))
}

function firstReviewAnchor(lines: ReviewDiffLine[], fallback: string) {
  const added = firstChangedBlock(lines, "add")
  if (added) return added
  const context = firstChangedBlock(lines, "ctx")
  return context || fallback
}

function firstChangedBlock(lines: ReviewDiffLine[], kind: ReviewDiffLine["kind"]) {
  const start = lines.findIndex((line) => line.kind === kind && reviewLineText(line).trim())
  if (start < 0) return ""
  const block: string[] = []
  for (const line of lines.slice(start)) {
    if (line.kind !== kind) break
    block.push(reviewLineText(line))
  }
  return block.join("\n")
}

function reviewLineText(line: ReviewDiffLine) {
  if ((line.kind === "add" || line.kind === "del" || line.kind === "ctx") && /^[+\- ]/.test(line.text)) {
    return line.text.slice(1)
  }
  return line.text
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

async function reviewHunk(relPath: string, action: ReviewHunkState, oldText: string, newText: string, silent = false): Promise<boolean> {
  if (action === "accepted") return true
  const uri = await workspaceFileUri(relPath)
  const doc = await vscode.workspace.openTextDocument(uri)
  const current = doc.getText()
  const match = findHunkText(current, newText)
  if (!match) {
    if (!silent) {
      vscode.window.showWarningMessage(`OpenCUI: could not undo hunk in ${relPath}; the file changed since the diff was generated.`)
      await vscode.window.showTextDocument(doc)
    }
    return false
  }
  const edit = new vscode.WorkspaceEdit()
  edit.replace(uri, new vscode.Range(doc.positionAt(match.start), doc.positionAt(match.end)), oldText)
  const ok = await vscode.workspace.applyEdit(edit)
  if (!ok) {
    if (!silent) vscode.window.showWarningMessage(`OpenCUI: could not undo hunk in ${relPath}`)
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
