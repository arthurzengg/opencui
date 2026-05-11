import * as vscode from "vscode"
import * as path from "path"
import type { ServerManager, Backend } from "../server"
import type { Preferences } from "../preferences"
import {
  subscribeSession,
  type PermissionRequest,
  type Subscription,
} from "./stream"
import { getEditorContext, formatContextHeader } from "../context"
import { searchWorkspaceFiles } from "../file-search"
import { pickAttachments } from "../attachments"
import { log } from "../output"
import type {
  Attachment,
  ChatBlock,
  ChatMessage,
  ConversationSummary,
  Inbound,
  Outbound,
  ToolUpdate as WireToolUpdate,
  Selection,
  ReviewChange,
  ReviewHunkState,
} from "../protocol"
import {
  ACTIVE_CONVERSATION_KEY,
  CONVERSATIONS_KEY,
  type SavedConversation,
  migrateConversationsToWorkspace,
} from "./conversation-store"
import { relativeToCwd, samePath } from "./paths"
import { isTextReviewPath, reviewKey, splitReviewDiff } from "./diff"
import { reviewChanges } from "./review-changes"
import { buildPrompt, readMentions } from "./prompt-builder"
import { toWire } from "./wire-format"
import {
  applyCode,
  openFile,
  openFileDocument,
  reviewHunk,
  reviewPathExists,
} from "./fs-ops"
import { fallbackHtml, hasPendingReviewHunks, reviewChangeHtml } from "./review-render"

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
  /**
   * True between user-pressed Stop and the subsequent `session.idle` event.
   * While true, drop incoming SSE message/tool deltas — opencode keeps draining
   * its in-flight LLM response for a moment after abort, and we don't want to
   * mutate the already-stopped message with leftover content.
   */
  private aborting = false

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
      case "userMessage": {
        const blocks: ChatBlock[] = []
        if (msg.attachments) {
          for (const a of msg.attachments) {
            blocks.push({
              type: "attachment",
              mime: a.mime,
              filename: a.filename,
              dataUrl: a.dataUrl,
              bytes: a.bytes,
            })
          }
        }
        blocks.push({ type: "text", text: msg.text })
        this.messages = [
          ...this.messages,
          {
            id: msg.id,
            role: "user",
            blocks,
            ref: msg.ref,
            backendID: msg.backendID,
            mentions: msg.mentions,
          },
        ]
        this.saveActive()
        return
      }
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
      case "aborted": {
        // Only the LAST pending assistant in the turn carries the Stopped
        // badge; intermediate ones just clear pending. Otherwise multi-step
        // turns (subtasks, retries) show several Stopped badges per abort.
        let lastPendingIdx = -1
        this.messages.forEach((m, i) => {
          if (m.role === "assistant" && m.pending) lastPendingIdx = i
        })
        this.messages = this.messages.map((m, i) => {
          if (m.role !== "assistant" || !m.pending) return m
          if (i === lastPendingIdx) return { ...m, pending: false, stopped: true }
          return { ...m, pending: false }
        })
        this.saveActive()
        return
      }
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
        await this.handleSend(msg.text, msg.mentions, msg.attachments)
        return
      case "editMessage":
        await this.handleEdit(msg.id, msg.text, msg.mentions, msg.attachments)
        return
      case "fileSearch":
        try {
          const hits = await searchWorkspaceFiles(msg.query)
          this.post({ type: "fileSearchResult", requestID: msg.requestID, hits })
        } catch (e) {
          log("fileSearch failed", e)
          this.post({ type: "fileSearchResult", requestID: msg.requestID, hits: [] })
        }
        return
      case "attachFile":
        try {
          const result = await pickAttachments()
          this.post({
            type: "attachmentResult",
            requestID: msg.requestID,
            attachments: result.attachments,
            error: result.error,
          })
        } catch (e) {
          log("attachFile failed", e)
          this.post({
            type: "attachmentResult",
            requestID: msg.requestID,
            attachments: [],
            error: (e as Error).message,
          })
        }
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
    this.aborting = true
    this.pendingUserBackendID = undefined
    this.post({ type: "aborted" })
    try {
      const backend = await this.servers.ensure()
      await backend.client.session.abort({ path: { id: this.sessionID } })
    } catch (e) {
      log("session.abort failed", e)
    }
    // Do NOT close SSE — opencode will emit the final events telling us the
    // assistant message ended (session.idle clears this.aborting).
  }

  private async handleSend(text: string, mentions?: string[], attachments?: Attachment[]) {
    const ctx = getEditorContext()
    const label = formatContextHeader(ctx)
    const userMessageID = "u_" + Date.now()
    this.pendingUserBackendID = userMessageID
    this.post({
      type: "userMessage",
      id: userMessageID,
      text,
      ref: { path: ctx.filePath, label },
      attachments,
      mentions,
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
    const mentionBlock = await readMentions(mentions)
    const parts: Array<Record<string, unknown>> = []
    if (attachments) {
      for (const a of attachments) {
        // Prefer the file:// URL of the actual file on disk so opencode can
        // read it directly (works regardless of whether the file lives in the
        // workspace). Falls back to the inline data URL for restored
        // attachments where the source path is no longer available.
        const url = a.sourcePath ? vscode.Uri.file(a.sourcePath).toString() : a.dataUrl
        parts.push({
          type: "file",
          mime: a.mime,
          filename: a.filename,
          url,
        })
      }
    }
    parts.push({ type: "text", text: buildPrompt(text, ctx, mentionBlock) })
    type PromptBody = NonNullable<Parameters<typeof backend.client.session.prompt>[0]["body"]>
    const body: PromptBody = {
      parts: parts as PromptBody["parts"],
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

  private async handleEdit(webviewID: string, text: string, mentions?: string[], attachments?: Attachment[]) {
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

    await this.handleSend(trimmed, mentions, attachments)
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
        // While aborting, opencode reports the assistant message's end with an
        // "Aborted"-style error. That's redundant with the Stopped badge we
        // already set on `aborted` — suppress to avoid showing both.
        if (payload.error && !this.aborting) {
          this.post({ type: "assistantError", id: webviewID, message: payload.error })
        }
        this.post({ type: "assistantDone", id: webviewID, usage: payload.usage })
      },
      onTextDelta: (mid, delta) => {
        if (this.aborting) return
        const webviewID = this.messageMap.get(mid) ?? this.ensureWebviewID(mid)
        this.post({ type: "textDelta", id: webviewID, delta })
      },
      onReasoningDelta: (mid, delta) => {
        if (this.aborting) return
        const webviewID = this.messageMap.get(mid) ?? this.ensureWebviewID(mid)
        this.post({ type: "reasoningDelta", id: webviewID, delta })
      },
      onTool: (mid, update) => {
        if (this.aborting) return
        const webviewID = this.messageMap.get(mid) ?? this.ensureWebviewID(mid)
        const wire = toWire(update, backend.directory)
        this.post({ type: "tool", id: webviewID, update: wire })
      },
      onPatch: (mid, files, diff) => {
        if (this.aborting) return
        const webviewID = this.messageMap.get(mid) ?? this.ensureWebviewID(mid)
        this.post({
          type: "patch",
          id: webviewID,
          files: files.map((f) => relativeToCwd(backend.directory, f)),
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
        this.aborting = false
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

