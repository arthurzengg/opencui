import * as vscode from "vscode"
import * as path from "path"
import type { ServerManager, Backend } from "../server"
import type { Preferences } from "../preferences"
import {
  subscribeSession,
  type PermissionRequest,
  type QuestionRequest,
  type Subscription,
  type Toast,
  type ToolUpdate,
} from "./stream"
import { getEditorContext, formatContextHeader } from "../context"
import { searchWorkspaceFiles } from "../file-search"
import { pickAttachments } from "../attachments"
import { log } from "../output"
import { getWorkspaceRoots, primaryWorkspaceRoot } from "../workspace-root"
import type { WorkspaceInfo } from "../protocol"
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
import { buildManifest } from "../workspace-context/manifest"
import { collectAutoContext } from "../workspace-context/collector"
import { RecentEditsTracker } from "../workspace-context/recent-edits"
import { readContextSettings } from "../workspace-context/budget"
import type { IndexManager } from "../indexing/index-manager"
import { AgentTaskStore, classifyTerminal, mainTaskID, type AgentTask } from "../agents/task-store"
import { SubagentTracker } from "../agents/subagent-tracker"
import type { AgentsStatusInfo, AgentsTaskInfo } from "../protocol"
import { toWire } from "./wire-format"
import {
  applyCode,
  openFile,
  openFileDocument,
  reviewHunk,
  reviewPathExists,
} from "./fs-ops"
import { fallbackHtml } from "./review-render"

/**
 * Recognize a toast that signals an imminent continuation. Exported so the
 * regex is testable in isolation. Patterns matched:
 *   - `Todo Continuation` / `Resuming in Ns...` — omo TodoContinuationEnforcer
 *     (`src/hooks/todo-continuation-enforcer/countdown.ts:20-30`).
 *   - `Background task complete|failed — ... Resuming the main thread.` —
 *     opencode's `task` tool auto-resume after a background subagent finishes
 *     (`packages/opencode/src/tool/task.ts:217-225`).
 *   - `New Background Task` — omo's task-toast-manager when a backgrounded
 *     subagent spawns (`src/features/task-toast-manager/manager.ts:193`).
 *   - Any phrasing containing `resuming` as a defensive catch-all.
 *
 * Notably we do NOT match `Task Completed` on its own — that toast can fire
 * for both midway and final task completions, so by itself it isn't a reliable
 * "expect another turn" signal. The structural check on running `task` tool
 * parts handles that case more precisely.
 */
export function isContinuationToast(toast: Toast): boolean {
  const haystack = `${toast.title ?? ""} ${toast.message}`.toLowerCase()
  return /continuation|resuming|new background task|background task (complete|failed)/.test(haystack)
}

export class ChatView implements vscode.WebviewViewProvider {
  static viewType = "opencui.chat"

  private view?: vscode.WebviewView
  private sessionID?: string
  private subscription?: Subscription
  private activePermissions = new Map<string, PermissionRequest>()
  private activeQuestions = new Map<string, QuestionRequest>()
  /**
   * Last (text + variant) pair we surfaced as a toast plus its timestamp.
   * opencode can fire identical `tui.toast.show` events dozens of times
   * per second (e.g. "Used N tools" while Hephaestus iterates) — we
   * suppress repeats within `TOAST_DEDUP_MS` of the previous identical one.
   */
  private lastToast?: { key: string; at: number }
  private static readonly TOAST_DEDUP_MS = 3000
  /**
   * Timestamp of the most recent *toast-style* signal that a continuation is
   * imminent (see `isContinuationToast`). Used as a defensive fallback gate
   * — if a plugin emits a continuation toast but never produces a
   * recognizable subagent dispatch tool, we still defer `sessionIdle` for
   * a bounded window. The PRIMARY gate is structural (live subagent tasks
   * in the store, tracked by `SubagentTracker`).
   */
  private lastContinuationSignalAt = 0
  private pendingIdleTimer?: ReturnType<typeof setTimeout>
  /**
   * True between `continuationPending: true` and either the deferred
   * `sessionIdle` firing, or a new `sessionBusy` / `assistantStart` /
   * abort cancelling the defer.
   */
  private idleDeferActive = false
  private static readonly CONTINUATION_SIGNAL_TTL_MS = 30_000
  /**
   * Max wait for a *toast-only* continuation (no active subagent tasks
   * in the store) to materialize before declaring idle. Long enough to
   * absorb the lag between a parent's idle and an omo plugin injecting
   * its continuation toast. The structural variant (live subagent
   * tasks) has no fixed cap — it waits for the child sessions
   * themselves to terminate.
   */
  private static readonly CONTINUATION_DEFER_MS = 120_000
  /**
   * After the last running subagent task settles while we were deferring,
   * wait this long for a continuation toast / new turn to arrive before
   * clearing busy. Most omo / opencode wakeups fire within a couple of
   * seconds.
   */
  private static readonly CONTINUATION_GRACE_MS = 10_000
  /** opencode messageID → webview-side id used in UI */
  private messageMap = new Map<string, string>()
  private conversations: SavedConversation[]
  private activeConversationID: string
  private messages: ChatMessage[] = []
  /** Webview ID of the user message currently awaiting a backend ID from the stream. */
  private pendingUserBackendID?: string
  private reviewHunks: Record<string, ReviewHunkState> = {}
  /**
   * True between user-pressed Stop and the subsequent `session.idle` event.
   * While true, drop incoming SSE message/tool deltas — opencode keeps draining
   * its in-flight LLM response for a moment after abort, and we don't want to
   * mutate the already-stopped message with leftover content.
   */
  private aborting = false
  private taskStoreUnsub?: vscode.Disposable
  /**
   * Full task-store ID of the main task for the turn currently in flight.
   * Minted at `recordMainTaskStart` and used by `recordMainTaskFinish` so a
   * follow-up turn in the same session doesn't try to mutate the previous
   * turn's terminal main row. Cleared by `markSessionIdle`/`cancelSessionTasks`
   * paths in `onSessionIdle`.
   */
  private currentMainTaskID?: string
  /**
   * Single per-conversation subagent state machine. Reset on
   * `createConversation` / `selectConversation` / `dispose`. Constructed
   * lazily inside `attachSubscription` because the SSE subscription's
   * `addChildSession` / `removeChildSession` are the wiring it depends
   * on — both don't exist until we have a session to subscribe to.
   */
  private subagentTracker?: SubagentTracker

  constructor(
    private context: vscode.ExtensionContext,
    private servers: ServerManager,
    private prefs: Preferences,
    private recentEdits: RecentEditsTracker,
    private indexManager: IndexManager,
    private taskStore?: AgentTaskStore,
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
    if (this.taskStore) {
      this.taskStoreUnsub = this.taskStore.onDidChange((tasks) => this.postAgentsStatus(tasks))
    }
  }

  private postAgentsStatus(tasks: AgentTask[]) {
    const status = summarizeAgentTasks(tasks, this.activeConversationID)
    log(
      `[agents-status] post snapshot conv=${this.activeConversationID} total=${status.total} (running=${status.running} waiting=${status.waiting} error=${status.error}) ids=[${status.tasks.map((t) => `${t.kind}:${t.id}`).join(", ")}]`,
    )
    this.post({ type: "agentsStatus", status })
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
    vscode.workspace.onDidChangeWorkspaceFolders(
      () => this.pushWorkspace(),
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
    this.resetContinuationState()
    this.subscription?.abort()
    this.subscription = undefined
    this.sessionID = undefined
    this.currentMainTaskID = undefined
    this.messageMap.clear()
    this.activePermissions.clear(); this.activeQuestions.clear()
    const conversation = this.addConversation("New conversation")
    this.activeConversationID = conversation.id
    this.messages = []
    this.reviewHunks = {}
    await this.persistConversations()
    this.sendConversationState()
    if (this.taskStore) this.postAgentsStatus(this.taskStore.list())
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
      { title: "Select OpenCode Panel conversation" },
    )
    if (!picked) return
    if ("create" in picked) {
      await this.createConversation()
      return
    }
    if ("id" in picked && typeof picked.id === "string") await this.selectConversation(picked.id)
  }

  private dispose() {
    this.resetContinuationState()
    this.subscription?.abort()
    this.subscription = undefined
    this.currentMainTaskID = undefined
    this.taskStoreUnsub?.dispose()
    this.taskStoreUnsub = undefined
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
    this.resetContinuationState()
    this.subscription?.abort()
    this.subscription = undefined
    this.currentMainTaskID = undefined
    this.messageMap.clear()
    this.activePermissions.clear(); this.activeQuestions.clear()
    this.activeConversationID = id
    this.restoreActiveState()
    await this.persistConversations()
    this.sendConversationState()
    if (this.taskStore) this.postAgentsStatus(this.taskStore.list())
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
    // Drop the deleted conversation's task history so the popover
    // doesn't carry forward rows the user can no longer trace back to
    // anything. Best-effort; failures here aren't fatal.
    if (this.taskStore) {
      void this.taskStore.clearForConversation(id)
    }
    if (this.activeConversationID === id) {
      this.resetContinuationState()
      this.subscription?.abort()
      this.subscription = undefined
      this.messageMap.clear()
      this.activePermissions.clear(); this.activeQuestions.clear()
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
      case "userMessageContext":
        this.messages = this.messages.map((m) =>
          m.id === msg.id ? { ...m, context: msg.context } : m,
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
    this.post({ type: "selection", selection: this.buildSelection() })
  }

  private buildSelection(): Selection {
    const sel = this.prefs.get()
    const model = sel.modelProviderID && sel.modelID ? `${sel.modelProviderID}/${sel.modelID}` : undefined
    return { agent: sel.agent, model, modelVariant: sel.modelVariant }
  }

  private pushContext() {
    const ctx = getEditorContext()
    const label = formatContextHeader(ctx)
    this.post({ type: "context", ref: { path: ctx.filePath, label } })
  }

  private pushWorkspace() {
    this.post({ type: "workspace", workspace: this.workspaceInfo() })
  }

  private workspaceInfo(): WorkspaceInfo | undefined {
    const root = primaryWorkspaceRoot()
    if (!root) return undefined
    const all = getWorkspaceRoots()
    const configMode =
      vscode.workspace.getConfiguration("opencui").get<string>("opencodeConfigMode") === "user"
        ? "user"
        : "isolated"
    return {
      name: root.name,
      root: root.fsPath,
      isDefault: root.isDefault,
      multiRoot: all.length > 1,
      configMode,
    }
  }

  private async onMessage(msg: Inbound) {
    switch (msg.type) {
      case "mounted": {
        this.post({
          type: "ready",
          connected: false,
          selection: this.buildSelection(),
        })
        this.sendConversationState()
        this.pushContext()
        this.pushWorkspace()
        this.indexManager.onStatusChange((status) => {
          this.post({ type: "indexStatus", status })
        })
        // Send current state immediately so the UI can render even before
        // the first lifecycle event.
        this.post({ type: "indexStatus", status: this.indexManager.currentStatus() })
        if (this.taskStore) this.postAgentsStatus(this.taskStore.list())
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
      case "selectVariant":
        log("selectVariant → executing opencui.selectVariant")
        await vscode.commands.executeCommand("opencui.selectVariant")
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
      case "questionReply": {
        this.activeQuestions.delete(msg.id)
        await this.replyQuestion(msg.id, msg.answers)
        return
      }
      case "questionReject": {
        this.activeQuestions.delete(msg.id)
        await this.rejectQuestion(msg.id)
        return
      }
      case "startIndex":
        void this.indexManager.start()
        return
      case "stopIndex":
        void this.indexManager.stop()
        return
    }
  }

  /**
   * POST the user's answers to opencode's question API. The installed SDK
   * (1.14.33) doesn't yet expose typed question methods — those landed in
   * the binary at 1.14.41 — so we use raw fetch against the backend URL.
   *
   * The reply / reject endpoints apply `WorkspaceRoutingMiddleware`, which
   * reads an optional `directory` query parameter to pick the right
   * workspace's pending-questions map. Without it, opencode falls back to
   * a different workspace, fails to find the pending request, logs
   * "reply for unknown request", and the original `Question.ask` Effect
   * stays blocked forever — exactly the "stuck after submit" symptom.
   */
  private async replyQuestion(requestID: string, answers: string[][]) {
    await this.postQuestionEndpoint(requestID, "reply", { answers })
  }

  private async rejectQuestion(requestID: string) {
    await this.postQuestionEndpoint(requestID, "reject")
  }

  private async postQuestionEndpoint(
    requestID: string,
    action: "reply" | "reject",
    body?: Record<string, unknown>,
  ) {
    try {
      const backend = await this.servers.ensure()
      const url = new URL(`${backend.url}/question/${encodeURIComponent(requestID)}/${action}`)
      if (backend.directory) url.searchParams.set("directory", backend.directory)
      log(`question ${action} POST`, url.toString(), body ?? {})
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      })
      const text = await res.text().catch(() => "")
      if (!res.ok) {
        log(`question ${action} failed`, res.status, text)
      } else {
        log(`question ${action} ok`, res.status, text || "(no body)")
      }
    } catch (e) {
      log(`question ${action} threw`, e)
    }
  }

  /**
   * Surface an opencode toast. Warnings and errors go to VS Code's native
   * notification slot so users actually see them. Info / success goes to the
   * output channel only — these are typically "MCP server connected" /
   * "added N tools" chatter and don't deserve a popup. Consecutive identical
   * toasts within TOAST_DEDUP_MS are dropped (opencode can fire bursts).
   */

  private markContinuationSignal(source: string) {
    this.lastContinuationSignalAt = Date.now()
    log(`[continuation] signal observed (${source})`)
    // If we're already in a *toast-only* defer (no active subagents) and
    // its cap timer is running, restart the cap so a fresh signal extends
    // the wait. With omo, a Background-task-complete toast can arrive
    // late into a Todo-Continuation wait — we want to honour the newer
    // signal rather than time out on the older one.
    if (this.idleDeferActive && this.activeSubagentCount() === 0 && this.pendingIdleTimer) {
      this.scheduleIdleEmit(ChatView.CONTINUATION_DEFER_MS, "signal-re-arm")
    }
  }

  private hasRecentContinuationSignal(): boolean {
    return Date.now() - this.lastContinuationSignalAt < ChatView.CONTINUATION_SIGNAL_TTL_MS
  }

  private hasContinuationGate(): boolean {
    return this.activeSubagentCount() > 0 || this.hasRecentContinuationSignal()
  }

  /**
   * Bridge from the SSE `onTool` callback to the SubagentTracker. The
   * tracker is the single source of truth for subagent records — view.ts
   * only owns the main-task lifecycle. We also keep `lastContinuationSignal`
   * armed off subagent activity as a second-source defense: if anything
   * else clears `idleDeferActive`'s timer, the structural store check
   * below in `onSessionIdle` will re-defer.
   *
   * Tracked tools live in `SubagentTracker.isSubagentDispatchTool()` —
   * see the omo source notes there.
   */
  private async forwardToolForSubagentTracking(
    update: ToolUpdate,
    messageID: string | undefined,
  ): Promise<void> {
    if (!this.subagentTracker) return
    if (!SubagentTracker.isSubagentDispatchTool(update.tool)) return
    log(
      `[agents-status] tool event tool=${update.tool} status=${update.status} callID=${update.callID}`,
    )
    await this.subagentTracker.handleToolUpdate(update, messageID)
    // When a subagent settles while a continuation defer is open,
    // collapse the defer down to the short post-settle grace window
    // so the UI doesn't sit at "Continuing…" forever waiting on a
    // follow-up that never comes.
    if (this.idleDeferActive && this.activeSubagentCount() === 0) {
      this.scheduleIdleEmit(ChatView.CONTINUATION_GRACE_MS, "subagents-settled")
    }
  }

  private activeSubagentCount(): number {
    if (!this.taskStore || !this.sessionID) return 0
    return this.taskStore.activeSubagentsForSession(this.sessionID).length
  }

  private async recordMainTaskStart(text: string): Promise<void> {
    if (!this.taskStore) {
      log("[agents-status] recordMainTaskStart skipped — no taskStore wired")
      return
    }
    if (!this.sessionID) {
      log("[agents-status] recordMainTaskStart skipped — no sessionID yet")
      return
    }
    const conversationID = this.activeConversationID
    const sessionID = this.sessionID
    const turnID = crypto.randomUUID()
    const id = mainTaskID(conversationID, sessionID, turnID)
    const now = Date.now()
    this.currentMainTaskID = id
    log(`[agents-status] recordMainTaskStart ${id}`)
    await this.taskStore.upsert({
      id,
      kind: "main",
      conversationID,
      sessionID,
      title: summarizePrompt(text),
      status: "running",
      startedAt: now,
      updatedAt: now,
    })
  }

  private async recordMainTaskFinish(status: "completed" | "error" | "cancelled", error?: string): Promise<void> {
    if (!this.taskStore) return
    const id = this.currentMainTaskID
    if (!id) return
    this.currentMainTaskID = undefined
    await this.taskStore.update(id, {
      status,
      error,
      updatedAt: Date.now(),
    })
  }

  private clearPendingIdle() {
    if (this.pendingIdleTimer) {
      clearTimeout(this.pendingIdleTimer)
      this.pendingIdleTimer = undefined
    }
  }

  /**
   * Cancel any in-flight continuation defer and tell the webview the
   * pending state is over. Used when a new turn starts (sessionBusy /
   * assistantStart), when abort takes over, or when we decide to clear
   * busy ourselves.
   */
  private finishContinuationPending() {
    this.clearPendingIdle()
    if (this.idleDeferActive) {
      this.idleDeferActive = false
      this.post({ type: "continuationPending", pending: false })
    }
  }

  /**
   * Open a continuation defer. While there are any active subagent tasks
   * for the parent session, no timer runs — we wait for child-session
   * idle events (routed through the SubagentTracker) to drive the close.
   * Otherwise (toast-only signal), a cap timer prevents an indefinite
   * wait if no continuation actually arrives.
   */
  private beginContinuationDefer(source: string) {
    this.clearPendingIdle()
    if (!this.idleDeferActive) {
      this.idleDeferActive = true
      this.post({ type: "continuationPending", pending: true })
    }
    log(
      `[continuation] deferring sessionIdle (${source}, subagents=${this.activeSubagentCount()}, signal=${this.hasRecentContinuationSignal()})`,
    )
    if (this.activeSubagentCount() > 0) return
    this.scheduleIdleEmit(ChatView.CONTINUATION_DEFER_MS, "toast-cap")
  }

  /**
   * Schedule the emission of `sessionIdle` after `delay`. Used both for
   * the post-subagent grace window and the toast-only cap. On fire, if a
   * subagent has spun up again (or never settled), the timer no-ops —
   * tracker callbacks will re-schedule when subagents settle.
   */
  private scheduleIdleEmit(delay: number, source: string) {
    this.clearPendingIdle()
    this.pendingIdleTimer = setTimeout(() => {
      this.pendingIdleTimer = undefined
      if (this.activeSubagentCount() > 0) {
        log(`[continuation] timer (${source}) fired but subagents still active; staying deferred`)
        return
      }
      log(`[continuation] timer (${source}) resolved; emitting sessionIdle`)
      this.idleDeferActive = false
      this.post({ type: "continuationPending", pending: false })
      this.post({ type: "sessionIdle" })
    }, delay)
  }

  /** Clear all continuation tracking — used on conversation switch / dispose / abort tail. */
  private resetContinuationState() {
    this.clearPendingIdle()
    this.idleDeferActive = false
    this.lastContinuationSignalAt = 0
    this.subagentTracker?.reset()
  }

  private surfaceToast(toast: Toast) {
    if (isContinuationToast(toast)) {
      this.markContinuationSignal(`toast:${toast.title ?? "(no title)"}`)
    }
    // Normalize the message before computing the dedup key so closely-related
    // toasts collapse into one:
    //   - Strip leading whitespace + symbols / punctuation. Some agents
    //     (OhMyOpenCode etc.) animate a spinner by sending the same toast
    //     every ~100ms with a different leading glyph (·, •, ●, ○, ◌, ◦, …).
    //   - Replace digit runs with "N". Countdown-style toasts like "Todo
    //     Continuation — Resuming in 2s… (4 tasks remaining)" change every
    //     second; without this they'd each be a distinct popup.
    //   - Collapse whitespace and lowercase for stable matching.
    const normalizedMessage = toast.message
      .replace(/^[\s\p{P}\p{S}]+/u, "")
      .replace(/\d+/g, "N")
      .replace(/\s+/g, " ")
      .toLowerCase()
      .trim()
    const key = `${toast.variant}|${toast.title ?? ""}|${normalizedMessage}`
    const now = Date.now()
    if (this.lastToast && this.lastToast.key === key && now - this.lastToast.at < ChatView.TOAST_DEDUP_MS) {
      return
    }
    this.lastToast = { key, at: now }
    const prefix = toast.title ? `OpenCode Panel: ${toast.title}` : "OpenCode Panel"
    const text = `${prefix} — ${toast.message}`
    log(`toast [${toast.variant}]`, text)
    switch (toast.variant) {
      case "error":
        void vscode.window.showErrorMessage(text)
        return
      case "warning":
        void vscode.window.showWarningMessage(text)
        return
      // info / success stay in the output channel only.
    }
  }

  private async abortCurrent() {
    if (!this.sessionID) return
    this.aborting = true
    this.pendingUserBackendID = undefined
    this.post({ type: "aborted" })
    void this.recordMainTaskFinish("cancelled")
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

    await this.recordMainTaskStart(text)

    const sel = this.prefs.get()
    const settings = readContextSettings(vscode.workspace.getConfiguration("opencui"))
    const symbolFocus = collectSymbolFocus(ctx.relativePath, mentions)
    const [mentionResult, auto] = await Promise.all([
      readMentions(mentions, settings.maxMentionBytes),
      backend.workspace
        ? collectAutoContext({
            workspace: backend.workspace,
            recentEdits: this.recentEdits,
            symbolFocus,
            enabled: settings.enabled,
            maxAutoBytes: settings.maxAutoBytes,
          })
        : Promise.resolve({ items: [], blocks: [] }),
    ])
    const manifest = buildManifest({
      workspace: backend.workspace,
      workspaceInfo: this.workspaceInfo(),
      configMode: backend.configMode,
      editor: ctx,
      mentions,
      attachments,
      mentionBytes: mentionResult.bytes,
    })
    // Merge automatic collector items into the manifest. The auto-context
    // builder already classified them by source / status / priority.
    manifest.items.push(...auto.items)
    for (const item of auto.items) {
      if (item.status === "included") manifest.totals.includedItems += 1
      if (item.status === "truncated") {
        manifest.totals.includedItems += 1
        manifest.totals.truncatedItems += 1
      }
      if (item.status === "skipped") manifest.totals.skippedItems += 1
      if (item.bytes && (item.status === "included" || item.status === "truncated")) {
        manifest.totals.includedBytes += item.bytes
      }
    }
    // Tag capped/failed mentions explicitly so the manifest shows them.
    for (const rel of mentionResult.capped) {
      manifest.items.push({
        id: `mention_skipped_${rel}`,
        source: "mention",
        kind: "file",
        label: rel,
        path: rel,
        reason: "Skipped: per-prompt mention cap exceeded",
        status: "skipped",
      })
      manifest.totals.skippedItems += 1
    }
    for (const rel of mentionResult.failed) {
      manifest.items.push({
        id: `mention_failed_${rel}`,
        source: "mention",
        kind: "file",
        label: rel,
        path: rel,
        reason: "Skipped: file unreadable (ENOENT or permission denied)",
        status: "skipped",
      })
      manifest.totals.skippedItems += 1
    }
    manifest.totals.budgetBytes = settings.maxBytes
    if (settings.showManifest) {
      this.post({ type: "userMessageContext", id: userMessageID, context: manifest })
    }
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
    parts.push({
      type: "text",
      text: buildPrompt(text, ctx, mentionResult.block, backend.workspace, auto.blocks),
    })
    type PromptBody = NonNullable<Parameters<typeof backend.client.session.prompt>[0]["body"]>
    const body: PromptBody = {
      parts: parts as PromptBody["parts"],
    }
    if (sel.agent) body!.agent = sel.agent
    if (sel.modelProviderID && sel.modelID) {
      body!.model = { providerID: sel.modelProviderID, modelID: sel.modelID }
    }
    if (sel.modelVariant) {
      // `variant` is a **top-level** sibling of `model` on opencode's
      // PromptInput schema — NOT nested inside the model object (see
      // opencode source `packages/opencode/src/session/prompt.ts` →
      // `ModelRef = Schema.Struct({ providerID, modelID })` and
      // `PromptInput = Schema.Struct({ ..., model: …, variant:
      // Schema.optional(Schema.String), … })`). Our bundled
      // `@opencode-ai/sdk` types haven't been regenerated to expose
      // this field yet; the HTTP server accepts it regardless.
      ;(body as unknown as { variant?: string }).variant = sel.modelVariant
    }
    const modelLog =
      sel.modelProviderID && sel.modelID
        ? `${sel.modelProviderID}/${sel.modelID}${sel.modelVariant ? `:${sel.modelVariant}` : ""}`
        : "default"
    log("prompt dispatch", { sessionID: this.sessionID, agent: sel.agent ?? "default", model: modelLog })
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
    const subscription = subscribeSession(backend, sessionID, {
      onUserMessage: (mid) => {
        const targetID = this.pendingUserBackendID
        if (!targetID) return
        const target = this.messages.find((m) => m.id === targetID)
        if (!target || target.backendID) return
        this.pendingUserBackendID = undefined
        this.post({ type: "userMessageBackendID", id: targetID, backendID: mid })
      },
      onAssistantStart: (mid) => {
        // A new assistant turn means any deferred idle is moot — clear it
        // so the timer doesn't accidentally fire mid-stream and clear busy.
        this.finishContinuationPending()
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
          // Server-side abort (no local Stop) arrives here as
          // `error: "Aborted"`. classifyTerminal routes that to
          // `cancelled` so the popover doesn't flash red on what is
          // really a quiet stop. The chat bubble's own /^aborted$/i
          // mapping keeps the UI consistent.
          const classified = classifyTerminal(payload.error)
          this.post({ type: "assistantError", id: webviewID, message: payload.error })
          void this.recordMainTaskFinish(classified.status, classified.error)
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
        // Forward to the subagent tracker FIRST so the store is
        // up-to-date before any downstream consumer (continuation gate,
        // popover snapshot) reads from it. `forwardToolForSubagentTracking`
        // is responsible for filtering to subagent-dispatch tools and for
        // re-keying the task once metadata surfaces the child sessionID.
        void this.forwardToolForSubagentTracking(update, mid)
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
      onQuestionAsked: (q) => {
        this.activeQuestions.set(q.id, q)
        this.post({
          type: "question",
          id: q.id,
          questions: q.questions,
        })
      },
      onQuestionResolved: (id) => {
        this.activeQuestions.delete(id)
        this.post({ type: "questionResolved", id })
      },
      onMessageRemoved: (backendID) => {
        const webviewID = this.messageMap.get(backendID)
        if (!webviewID) return
        this.messageMap.delete(backendID)
        this.post({ type: "messageRemoved", id: webviewID })
      },
      onToast: (toast) => this.surfaceToast(toast),
      onSessionError: (message) => {
        log("session error", message)
      },
      onSessionBusy: () => {
        // A new busy state means continuation (if any) took over — cancel
        // any pending idle so we don't accidentally clear busy later.
        this.finishContinuationPending()
        this.post({ type: "sessionBusy" })
      },
      onSessionIdle: () => {
        const wasAborting = this.aborting
        this.aborting = false
        if (wasAborting) {
          // User-initiated abort bypasses the continuation defer — Stop
          // means stop now. Clear all continuation tracking so any
          // in-flight task parts (whose terminal events the SSE may not
          // send post-abort) don't poison the next turn. opencode's
          // session.abort propagates to child sessions too, so we
          // settle the entire subagent tree as cancelled.
          this.resetContinuationState()
          if (this.sessionID && this.taskStore) {
            void this.taskStore.cancelSessionTasks(this.sessionID)
          }
          this.currentMainTaskID = undefined
          this.post({ type: "sessionIdle" })
          return
        }
        if (this.hasContinuationGate()) {
          this.beginContinuationDefer("sessionIdle")
          return
        }
        this.finishContinuationPending()
        if (this.sessionID && this.taskStore) {
          void this.taskStore.markSessionIdle(this.sessionID)
        }
        this.currentMainTaskID = undefined
        this.post({ type: "sessionIdle" })
      },
      onChildSessionEvent: (event) => {
        if (!this.subagentTracker) return
        void this.subagentTracker.handleChildSessionEvent(event).then(() => {
          // After any child terminal event, if we were deferring an
          // idle waiting on subagents and the store is now empty,
          // arm the short grace timer.
          if (this.idleDeferActive && this.activeSubagentCount() === 0) {
            this.scheduleIdleEmit(ChatView.CONTINUATION_GRACE_MS, "child-settled")
          }
        })
      },
    })
    this.subscription = subscription
    if (this.taskStore) {
      this.subagentTracker = new SubagentTracker({
        store: this.taskStore,
        getActiveConversationID: () => this.activeConversationID,
        getParentSessionID: () => this.sessionID,
        subscription: {
          addChildSession: (id) => subscription.addChildSession(id),
          removeChildSession: (id) => subscription.removeChildSession(id),
        },
      })
      // Reconcile any rows that survived a VS Code reload. Best-effort —
      // failures fall through and stale rows simply linger until the
      // user clears them.
      void this.subagentTracker.reconcile(backend, sessionID)
    }
    try {
      await subscription.ready
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
      vscode.window.showWarningMessage(`OpenCode Panel: ${change.path} cannot be reviewed as text.`)
      return
    }
    try {
      const doc = await openFileDocument(change.path)
      // If the requested file is already the active editor, don't re-show it —
      // showTextDocument would steal focus + flash the editor pane for no
      // reason. (Common when the user just clicked a different row and the
      // editor already moved there.)
      const active = vscode.window.activeTextEditor?.document.uri.toString()
      if (active !== doc.uri.toString()) {
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false })
      }
      // Decoration sync (purging missing-file hunks) is independent of where
      // the editor is pointed — run it AFTER the editor swap so the visible
      // pane updates immediately rather than waiting on fs.stat I/O.
      void this.syncReviewDecorations()
    } catch (e) {
      log(`could not open review file ${change.path}`, e)
      vscode.window.showWarningMessage(`OpenCode Panel: could not open ${change.path} as text.`)
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
        `OpenCode Panel: ${requestedPath} is no longer present; removed ${purged} pending hunk${purged === 1 ? "" : "s"} from review.`,
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

/**
 * Tool names that represent dispatching a subagent. Mirrors
 * `TASK_TOOLS` + `TARGET_TOOLS2` from oh-my-opencode's source plus the
 * omo background-task and delegate-task families:
 *   - `task` / `Task` / `task_tool` — opencode's built-in task tool (and
 *     omo's `delegateTask` which is registered under the name `task`).
 *   - `delegate_task` — defensive: if a future omo version re-registers
 *     this with its lowercase name we still catch it.
 *   - `call_omo_agent` — omo's parallel subagent dispatcher used by the
 *     deep-agent stack (Hephaestus / Sisyphus / Prometheus).
 *   - `background_task` — omo's pure background dispatcher, used by
 *     Hephaestus prompts for fire-and-forget worker tasks.
 * Kept in sync with the internal set in `src/agents/subagent-tracker.ts`.
 */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  "task",
  "Task",
  "task_tool",
  "delegate_task",
  "call_omo_agent",
  "background_task",
])

export function isSubagentTool(toolName: string): boolean {
  return SUBAGENT_TOOLS.has(toolName)
}

export function summarizeAgentTasks(
  tasks: AgentTask[],
  conversationID?: string,
): AgentsStatusInfo {
  const scoped = conversationID
    ? tasks.filter((task) => task.conversationID === conversationID)
    : tasks

  // The popover shows ONLY currently-active work — the latest main task
  // and any subagents that are still running / waiting / errored. We drop
  // `completed` and `cancelled` rows so the popover reflects "what's
  // happening right now," not a per-chat history. A second user prompt
  // gets its own main row (see mainTaskID's per-turn keying); the prior
  // turn's row is settled and filtered out.
  const items: AgentsTaskInfo[] = []
  let running = 0
  let waiting = 0
  let error = 0
  for (const task of scoped) {
    if (task.status === "running") running += 1
    else if (task.status === "waiting") waiting += 1
    else if (task.status === "error") error += 1
    else continue
    items.push({
      id: task.id,
      kind: task.kind,
      title: task.title,
      status: task.status,
      error: task.error,
      startedAt: task.startedAt,
      updatedAt: task.updatedAt,
      subagent: task.kind === "subagent" ? task.subagent : undefined,
      category: task.kind === "subagent" ? task.category : undefined,
      model: task.kind === "subagent" ? task.model : undefined,
    })
  }
  // Stable order: main tasks first (the user's prompt anchor), then
  // subagents by startedAt asc. Within each kind, chronological order
  // is what makes "scrolling back through the turn" make sense.
  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "main" ? -1 : 1
    return a.startedAt - b.startedAt
  })
  return { running, waiting, error, total: running + waiting + error, tasks: items }
}

export function taskTitleFromUpdate(update: ToolUpdate): string {
  const input = update.input
  if (input && typeof input === "object") {
    const description = (input as Record<string, unknown>).description
    if (typeof description === "string" && description.trim()) return description.trim()
  }
  if (update.title && update.title.trim()) return update.title.trim()
  return "Background agent"
}

export function summarizePrompt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 64) || "Main agent"
}

function collectSymbolFocus(activeRel: string | undefined, mentions: string[] | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (p: string | undefined) => {
    if (!p) return
    if (path.isAbsolute(p)) return
    if (seen.has(p)) return
    seen.add(p)
    out.push(p)
  }
  push(activeRel)
  for (const m of mentions ?? []) push(m)
  return out
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

