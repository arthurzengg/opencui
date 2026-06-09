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
import { searchWorkspaceFiles, listWorkspaceDir } from "../file-search"
import { pickAttachments } from "../attachments"
import { log } from "../output"
import { getWorkspaceRoots, primaryWorkspaceRoot } from "../workspace-root"
import type { WorkspaceInfo } from "../protocol"
import type {
  Attachment,
  ChatBlock,
  ChatMessage,
  CommandInfo,
  ContextUsage,
  Inbound,
  Outbound,
  ToolUpdate as WireToolUpdate,
  Selection,
  ReviewChange,
  ReviewChangeActor,
  ReviewHunkState,
} from "../protocol"
import { BUILTIN_COMMAND_NAMES, withBuiltinCommands, generateMessageID } from "./builtin-commands"
import { lastUserTurnIndex, redoAction, userMessageText } from "./undo"
import { migrateConversationsToWorkspace } from "./conversation-store"
import { ConversationManager } from "./conversation-manager"
import { ContinuationState } from "./continuation-state"
import { SubagentDispatch } from "./subagent-dispatch"
export { summarizePrompt } from "./subagent-dispatch"
import { relativeToCwd, samePath } from "./paths"
import { isTextReviewPath, reviewKey, splitReviewDiff } from "./diff"
import { extractChanges, reviewChanges } from "./review-changes"
import { reviewAllForPath } from "./review-actions"
import { buildPrompt, readMentions, readConversationMentions } from "./prompt-builder"
import { buildManifest } from "../workspace-context/manifest"
import { collectAutoContext } from "../workspace-context/collector"
import { RecentEditsTracker } from "../workspace-context/recent-edits"
import { readContextSettings } from "../workspace-context/budget"
import type { IndexManager } from "../indexing/index-manager"
import {
  AgentTaskStore,
  ATTENTION_STATUSES,
  classifyTerminal,
  isAttentionStatus,
  type AgentTask,
  type AttentionStatus,
} from "../agents/task-store"
import { SubagentTracker } from "../agents/subagent-tracker"
import type { AgentsStatusInfo, AgentsTaskInfo } from "../protocol"
import { toWire } from "./wire-format"
import {
  applyCode,
  openFile,
  openFileDocument,
  reviewPathExists,
} from "./fs-ops"

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
  /** Background re-sweeps after a Stop, to catch late orchestrator dispatches. */
  private static readonly ABORT_DRAIN_PASSES = 6
  private static readonly ABORT_DRAIN_INTERVAL_MS = 1000
  /**
   * "This turn isn't done yet" defer for opencode/omo continuations.
   * Owns its own timer + signal gating; see {@link ContinuationState}
   * for the two-source defer logic.
   */
  private continuationState: ContinuationState
  /** opencode messageID → webview-side id used in UI */
  private messageMap = new Map<string, string>()
  /**
   * Tails removed by `/undo`, newest last, so `/redo` can re-append them. Purely
   * in-memory: it does not survive a reload, and any new turn or conversation
   * switch clears it (the future has diverged). No server->ChatMessage converter
   * exists, so this buffer is how redo rebuilds the removed messages.
   */
  private redoStack: ChatMessage[][] = []
  private manager: ConversationManager
  private messages: ChatMessage[] = []
  /** Webview ID of the user message currently awaiting a backend ID from the stream. */
  private pendingUserBackendID?: string
  private reviewHunks: Record<string, ReviewHunkState> = {}
  private contextUsageRequest = 0
  /** Names from the last `command.list` fetch — lets a custom command shadow a built-in. */
  private customCommandNames = new Set<string>()
  /**
   * True between user-pressed Stop and the subsequent `session.idle` event.
   * While true, drop incoming SSE message/tool deltas — opencode keeps draining
   * its in-flight LLM response for a moment after abort, and we don't want to
   * mutate the already-stopped message with leftover content.
   */
  private aborting = false
  private taskStoreUnsub?: vscode.Disposable
  /**
   * Owns the per-turn main-task lifecycle in the AgentTaskStore and
   * bridges SSE tool events into the SubagentTracker. See
   * {@link SubagentDispatch}.
   */
  private subagentDispatch: SubagentDispatch
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
    // Memento.update writes to the in-memory cache synchronously and only the
    // disk flush is async, so the very-next `workspaceState.get` below still
    // sees the migrated data. We `.catch` here so a disk-flush rejection is
    // logged (and the migration-done flag stays unset, retrying next launch).
    void migrateConversationsToWorkspace(context).catch((e) => log("migrateConversations failed", e))
    this.manager = new ConversationManager(context)
    this.subagentDispatch = new SubagentDispatch({
      taskStore: this.taskStore,
      getSessionID: () => this.sessionID,
      getActiveConversationID: () => this.manager.getActiveID(),
      collapseToGraceIfSettled: () => this.continuationState.collapseToGraceIfSettled(),
    })
    this.continuationState = new ContinuationState({
      post: (msg) => this.post(msg),
      activeSubagentCount: () => this.subagentDispatch.activeSubagentCount(),
    })
    this.applyActiveSnapshot()
    void this.manager.persist()
    if (this.taskStore) {
      this.taskStoreUnsub = this.taskStore.onDidChange((tasks) => this.postAgentsStatus(tasks))
    }
  }

  private postAgentsStatus(tasks: AgentTask[]) {
    const activeID = this.manager.getActiveID()
    const status = summarizeAgentTasks(tasks, activeID)
    log(
      `[agents-status] post snapshot conv=${activeID} total=${status.total} (running=${status.running} waiting=${status.waiting} error=${status.error}) ids=[${status.tasks.map((t) => `${t.kind}:${t.id}`).join(", ")}]`,
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
      const message = `Failed to build webview: ${(e as Error).message}`
      view.webview.html = `<!doctype html><html><body style="padding:20px;font-family:sans-serif;">
    <h2>OpenCode Panel</h2><p>${message}</p></body></html>`
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
    this.resetSessionState()
    const conversation = this.manager.add("New conversation")
    this.manager.setActiveID(conversation.id)
    this.messages = []
    this.reviewHunks = {}
    await this.manager.flushPersist()
    this.sendConversationState()
    this.post({ type: "contextUsage", usage: undefined })
    if (this.taskStore) this.postAgentsStatus(this.taskStore.list())
  }

  async pickConversation() {
    const activeID = this.manager.getActiveID()
    const picked = await vscode.window.showQuickPick(
      [
        { label: "$(plus) New conversation", description: "Start a saved conversation", create: true },
        ...this.manager.summaries().map((c) => ({
          label: c.title,
          description: c.id === activeID ? "current" : new Date(c.updatedAt).toLocaleString(),
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
    this.resetSessionTracking()
    this.subscription?.abort()
    this.subscription = undefined
    this.aborting = false
    this.taskStoreUnsub?.dispose()
    this.taskStoreUnsub = undefined
    // Write any debounced tail before the view (and its context) goes away,
    // then stop accepting further debounced writes so a late timer can't fire
    // after teardown.
    void this.manager.flushPersist()
    this.manager.dispose()
  }

  /**
   * Flush any debounced conversation write to disk. Awaited from the
   * extension's `deactivate()` so a graceful shutdown mid-stream loses
   * nothing beyond the in-flight token.
   */
  flushPersist(): Promise<void> {
    return this.manager.flushPersist()
  }

  private post(msg: Outbound) {
    this.applyLocal(msg)
    this.view?.webview.postMessage(msg)
  }

  private sendConversationState() {
    this.post({
      type: "conversations",
      conversations: this.manager.summaries(),
      activeID: this.manager.getActiveID(),
    })
    this.post({
      type: "restore",
      conversationID: this.manager.getActiveID(),
      messages: this.messages,
      reviewHunks: this.reviewHunks,
    })
  }

  private postConversationsList() {
    this.post({
      type: "conversations",
      conversations: this.manager.summaries(),
      activeID: this.manager.getActiveID(),
    })
  }

  /**
   * Hydrate live ChatView fields from the manager's persisted snapshot
   * of the active conversation.
   */
  private applyActiveSnapshot() {
    const snapshot = this.manager.loadActiveSnapshot()
    this.sessionID = snapshot.sessionID
    this.messages = snapshot.messages
    this.reviewHunks = snapshot.reviewHunks
  }

  /**
   * Tear down the live session state — used by createConversation /
   * selectConversation / deleteConversation when switching off the
   * current conversation. The manager's data stays intact; this only
   * resets the subscription + in-flight per-turn state.
   */
  private resetSessionState() {
    this.contextUsageRequest++
    this.resetSessionTracking()
    this.subscription?.abort()
    this.subscription = undefined
    this.aborting = false
    this.sessionID = undefined
    this.messageMap.clear()
    this.redoStack = []
    this.activePermissions.clear()
    this.activeQuestions.clear()
  }

  private async selectConversation(id: string) {
    if (id === this.manager.getActiveID()) return
    this.resetSessionState()
    this.manager.setActiveID(id)
    this.applyActiveSnapshot()
    await this.manager.flushPersist()
    this.sendConversationState()
    this.post({ type: "contextUsage", usage: undefined })
    if (this.sessionID) void this.refreshContextUsage()
    if (this.taskStore) this.postAgentsStatus(this.taskStore.list())
  }

  private async renameConversation(id: string, title: string) {
    this.manager.rename(id, title)
    await this.manager.flushPersist()
    this.postConversationsList()
  }

  private async deleteConversation(id: string) {
    const wasActive = this.manager.getActiveID() === id
    this.manager.remove(id)
    // Drop the deleted conversation's task history so the popover
    // doesn't carry forward rows the user can no longer trace back to
    // anything. Best-effort; failures here aren't fatal.
    if (this.taskStore) {
      void this.taskStore.clearForConversation(id)
    }
    if (wasActive) {
      this.resetSessionState()
      this.manager.setActiveID(this.manager.summaries()[0]!.id)
      this.applyActiveSnapshot()
      await this.manager.flushPersist()
      this.sendConversationState()
      this.post({ type: "contextUsage", usage: undefined })
      if (this.sessionID) void this.refreshContextUsage()
      return
    }
    await this.manager.flushPersist()
    this.postConversationsList()
  }

  private saveActive() {
    this.manager.saveActiveSnapshot({
      sessionID: this.sessionID,
      messages: this.messages,
      reviewHunks: this.reviewHunks,
    })
    this.manager.schedulePersist()
  }

  private updateTitleFromPrompt(text: string) {
    if (this.manager.updateTitleFromPrompt(text, this.messages.length)) {
      this.postConversationsList()
    }
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
            conversationMentions: msg.conversationMentions,
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
        this.messages = upsertTool(this.messages, msg.id, msg.update, msg.actor)
        this.saveActive()
        this.queueReviewDecorationsSync()
        return
      case "patch":
        this.messages = this.messages.map((m) =>
          m.id === msg.id
            ? { ...m, blocks: [...m.blocks, { type: "patch", files: msg.files, diff: msg.diff, actor: msg.actor }] }
            : m,
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

  private async refreshContextUsage(backend?: Backend) {
    const sessionID = this.sessionID
    if (!sessionID) {
      this.post({ type: "contextUsage", usage: undefined })
      return
    }
    const request = ++this.contextUsageRequest
    try {
      const activeBackend = backend ?? await this.servers.ensure()
      const usage = await readContextUsage(activeBackend, sessionID)
      if (request !== this.contextUsageRequest || this.sessionID !== sessionID) return
      this.post({ type: "contextUsage", usage })
    } catch (e) {
      log("context usage refresh failed", e)
    }
  }

  /**
   * Fetch the workspace's opencode custom commands and push them to the webview
   * for the `/` picker. Workspace/directory-scoped (not per-session), so there
   * is no request-sequence guard — a redundant refresh just re-sends the same
   * list. `takesArguments` (template contains `$ARGUMENTS`) drives the picker's
   * smart run UX.
   */
  private async refreshCommands(backend?: Backend) {
    try {
      const activeBackend = backend ?? (await this.servers.ensure())
      const res = await activeBackend.client.command.list({
        query: { directory: activeBackend.directory },
      })
      if (res.error || !res.data) {
        log("command.list failed", res.error)
        return
      }
      const custom: CommandInfo[] = res.data.map((c) => ({
        name: c.name,
        description: c.description,
        agent: c.agent,
        takesArguments: /\$ARGUMENTS\b/.test(c.template),
      }))
      this.customCommandNames = new Set(custom.map((c) => c.name))
      // Merge opencode's built-ins (/compact, /share, …); a custom command of
      // the same name wins and is dispatched through session.command instead.
      this.post({ type: "commands", commands: withBuiltinCommands(custom) })
    } catch (e) {
      log("command.list refresh failed", e)
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
          const backend = await this.servers.ensure()
          this.post({ type: "connected", connected: true })
          void this.refreshCommands(backend)
          if (this.sessionID) void this.refreshContextUsage(backend)
        } catch (e) {
          this.post({ type: "connected", connected: false, error: (e as Error).message })
        }
        return
      }
      case "send":
        await this.handleSend(msg.text, msg.mentions, msg.attachments, msg.conversationMentions)
        return
      case "runCommand":
        await this.handleRunCommand(msg.command, msg.arguments)
        return
      case "editMessage":
        await this.handleEdit(msg.id, msg.text, msg.mentions, msg.attachments, msg.conversationMentions)
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
      case "listDir":
        try {
          const entries = await listWorkspaceDir(msg.path)
          this.post({ type: "listDirResult", requestID: msg.requestID, entries })
        } catch (e) {
          log("listDir failed", e)
          this.post({ type: "listDirResult", requestID: msg.requestID, entries: [] })
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

  /**
   * Tear down the continuation state machine + the subagent tracker.
   * Used at conversation boundaries, dispose, and after a user-initiated
   * abort settles. Both pieces are session-scoped — they don't survive
   * a switch.
   */
  private resetSessionTracking() {
    this.continuationState.reset()
    this.subagentTracker?.reset()
    this.subagentDispatch.clearMainTaskID()
  }

  private surfaceToast(toast: Toast) {
    if (isContinuationToast(toast)) {
      this.continuationState.markSignal(`toast:${toast.title ?? "(no title)"}`)
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
    const sessionID = this.sessionID
    this.aborting = true
    this.pendingUserBackendID = undefined
    this.post({ type: "aborted" })
    void this.subagentDispatch.recordMainTaskFinish("cancelled")

    // Tear down the tracker's local view of the subagent tree first.
    // Two reasons:
    //   1. The store mutation runs in-process and is fast; doing it
    //      first means the popover settles immediately instead of
    //      waiting on the network round-trip.
    //   2. With the store's strict terminal guard, marking tasks
    //      `cancelled` now makes the user's Stop sticky — a late
    //      child error event (rate-limit / token-expired races
    //      arriving after the abort propagation) can no longer flip
    //      a cancelled row to `error`.
    const gen = ++this.abortGen
    let childSessionIDs: string[] = []
    if (this.subagentTracker) {
      childSessionIDs = await this.subagentTracker.cancelForSession(sessionID)
    } else if (this.taskStore) {
      await this.taskStore.cancelSessionTasks(sessionID)
    }

    try {
      const backend = await this.servers.ensure()
      // Abort the WHOLE session subtree, root first.
      //
      // opencode's `session.abort` only propagates to foreground children
      // (the parent is blocked on their tool call). Background subagents and
      // omo's orchestrator sessions (e.g. Sisyphus) run as independent
      // sessions the parent never awaits, so a parent-only abort leaves them
      // alive — and an alive orchestrator keeps dispatching NEW background
      // tasks seconds after Stop. We therefore walk opencode's authoritative
      // tree (`session.children`, recursive) and abort every descendant,
      // seeded with the tracker's known child IDs in case a just-spawned
      // child isn't in `session.children` yet.
      //
      // Root is aborted first: an earlier version aborted parent + children
      // in parallel and hit a race where a child's cancel result reached the
      // still-live parent and spun up a new turn. Settling the parent before
      // its children closes that race.
      await this.sweepAbortTree(backend.client, sessionID, childSessionIDs, gen)
      // The first sweep can miss sessions the orchestrator dispatches while
      // the sweep is in flight. Drain in the background until a sweep finds
      // nothing new (or the user starts a new turn, bumping `abortGen`).
      void this.drainAbortTree(backend.client, sessionID, gen)
    } catch (e) {
      log("session.abort failed", e)
    }
    // Do NOT close SSE — opencode will emit the final events telling us the
    // assistant message ended (session.idle clears this.aborting).
  }

  /**
   * Tracks every session id aborted in the current Stop so re-sweeps don't
   * re-abort the same node and the drain loop can tell when it has gone quiet.
   * Cleared at the start of each sweep generation.
   */
  private abortedTree = new Set<string>()
  /**
   * Monotonic token identifying the current Stop. Bumped on each
   * `abortCurrent` and on each new user turn (`handleSend`) so a background
   * drain loop from a previous Stop cannot abort sessions belonging to work
   * the user has since restarted.
   */
  private abortGen = 0

  /**
   * One breadth-first pass over the session subtree rooted at `rootID`,
   * aborting every session not already aborted this generation. Returns the
   * number of sessions newly aborted in this pass. `seed` lets the caller
   * inject child IDs known to the tracker that may not yet show up in
   * `session.children`.
   */
  private async sweepAbortTree(
    client: Backend["client"],
    rootID: string,
    seed: string[],
    gen: number,
  ): Promise<number> {
    let newlyAborted = 0
    const queue = [rootID, ...seed]
    while (queue.length) {
      if (gen !== this.abortGen) break
      const id = queue.shift()!
      if (this.abortedTree.has(id)) continue
      this.abortedTree.add(id)
      newlyAborted++
      try {
        await client.session.abort({ path: { id } })
      } catch (e) {
        log("session.abort failed", id, e)
      }
      try {
        const res = await client.session.children({ path: { id } })
        for (const child of res.data ?? []) {
          if (child?.id && !this.abortedTree.has(child.id)) queue.push(child.id)
        }
      } catch (e) {
        log("session.children failed", id, e)
      }
    }
    return newlyAborted
  }

  /**
   * Re-sweep the subtree until a pass finds no new sessions, catching tasks
   * the orchestrator dispatches in the window after the initial sweep. Bounded
   * by iteration count and abandoned the moment `abortGen` moves on.
   */
  private async drainAbortTree(client: Backend["client"], rootID: string, gen: number): Promise<void> {
    for (let i = 0; i < ChatView.ABORT_DRAIN_PASSES && gen === this.abortGen; i++) {
      await delay(ChatView.ABORT_DRAIN_INTERVAL_MS)
      if (gen !== this.abortGen) return
      const found = await this.sweepAbortTree(client, rootID, [], gen)
      if (found === 0) return
      log(`[abort] drain pass ${i + 1} aborted ${found} late session(s)`)
    }
  }

  private async handleSend(text: string, mentions?: string[], attachments?: Attachment[], conversationMentions?: string[]) {
    // A new turn supersedes any in-flight abort drain from a prior Stop so it
    // can't abort the session tree the new turn is about to (re)use.
    this.abortGen++
    this.redoStack = [] // a new turn diverges the history; nothing to redo
    const ctx = getEditorContext()
    const label = formatContextHeader(ctx)
    const userMessageID = "u_" + Date.now()
    const activeConversationID = this.manager.getActiveID()
    const pastConversationMentions = conversationMentions?.filter(
      (id, index, ids) => id !== activeConversationID && ids.indexOf(id) === index,
    )
    const attachedConversationMentions = pastConversationMentions?.length ? pastConversationMentions : undefined
    this.pendingUserBackendID = userMessageID
    this.post({
      type: "userMessage",
      id: userMessageID,
      text,
      ref: { path: ctx.filePath, label },
      attachments,
      mentions,
      conversationMentions: attachedConversationMentions,
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
      this.manager.updateActive((conversation) => ({ ...conversation, sessionID: this.sessionID }))
      await this.manager.flushPersist()
      log("created session", this.sessionID)
      await this.attachSubscription(backend, this.sessionID)
    } else if (!this.subscription) {
      await this.attachSubscription(backend, this.sessionID)
    }

    await this.subagentDispatch.recordMainTaskStart(text)

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
    const convResult = readConversationMentions(
      attachedConversationMentions,
      (id) => this.manager.getMessages(id),
      (id) => this.manager.getTitle(id),
    )
    for (const [id, info] of Object.entries(convResult.bytes)) {
      const title = this.manager.getTitle(id) ?? id
      manifest.items.push({
        id: `conv_mention_${id}`,
        source: "conversation",
        kind: "conversation",
        label: title,
        reason: "Past conversation attached via @-mention",
        status: info.included < info.original ? "truncated" : "included",
        bytes: info.included,
      })
      manifest.totals.includedItems += 1
      manifest.totals.includedBytes += info.included
      if (info.included < info.original) manifest.totals.truncatedItems += 1
    }
    for (const id of convResult.capped) {
      manifest.items.push({
        id: `conv_capped_${id}`,
        source: "conversation",
        kind: "conversation",
        label: this.manager.getTitle(id) ?? id,
        reason: "Skipped: conversation mention byte cap exceeded",
        status: "skipped",
      })
      manifest.totals.skippedItems += 1
    }
    for (const id of convResult.failed) {
      manifest.items.push({
        id: `conv_failed_${id}`,
        source: "conversation",
        kind: "conversation",
        label: id,
        reason: "Skipped: conversation not found",
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
      text: buildPrompt(
        text,
        ctx,
        [mentionResult.block, convResult.block].filter(Boolean).join("\n\n") || undefined,
        backend.workspace,
        auto.blocks,
      ),
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

  /**
   * Run an opencode custom command. Unlike handleSend this skips the entire
   * auto-context/manifest pipeline: `session.command` takes no `parts`, so the
   * server expands the command's own template (including its `!shell` / `@file`
   * substitutions) and runs the turn. The existing SSE subscription renders it.
   */
  private async handleRunCommand(command: string, args: string) {
    // A built-in (/compact, /share, …) maps to a dedicated session endpoint,
    // not session.command — unless a custom command of the same name shadows it.
    if (!this.customCommandNames.has(command) && BUILTIN_COMMAND_NAMES.has(command)) {
      await this.handleBuiltinCommand(command)
      return
    }
    this.redoStack = [] // a custom-command turn diverges the history
    const ctx = getEditorContext()
    const label = formatContextHeader(ctx)
    const userMessageID = "u_" + Date.now()
    // Show the typed invocation, never the expanded template — the SSE
    // onUserMessage only associates the backend id, it never rewrites the text.
    const display = "/" + command + (args ? " " + args : "")
    this.pendingUserBackendID = userMessageID
    this.post({
      type: "userMessage",
      id: userMessageID,
      text: display,
      ref: { path: ctx.filePath, label },
    })
    this.updateTitleFromPrompt(display)

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
      this.manager.updateActive((conversation) => ({ ...conversation, sessionID: this.sessionID }))
      await this.manager.flushPersist()
      log("created session", this.sessionID)
      await this.attachSubscription(backend, this.sessionID)
    } else if (!this.subscription) {
      await this.attachSubscription(backend, this.sessionID)
    }

    // A command is a real main-agent turn (it can spawn subagents), so it must
    // key the Agents popover identically to a prompt. Finish is handled by the
    // shared SSE onAssistantEnd / onSessionIdle paths.
    await this.subagentDispatch.recordMainTaskStart(display)

    const sel = this.prefs.get()
    // session.command's `model` is a single "providerID/modelID" string, unlike
    // promptAsync's { providerID, modelID } object.
    const model = sel.modelProviderID && sel.modelID ? `${sel.modelProviderID}/${sel.modelID}` : undefined
    log("command dispatch", { sessionID: this.sessionID, command, agent: sel.agent ?? "default", model: model ?? "default" })
    const body = {
      command,
      arguments: args,
      ...(sel.agent ? { agent: sel.agent } : {}),
      ...(model ? { model } : {}),
    }
    if (sel.modelVariant) {
      // `variant` is a top-level field the command endpoint accepts (same as
      // promptAsync in handleSend); the bundled SDK types don't expose it yet.
      // Without this, custom /commands silently run at the model's default effort.
      ;(body as unknown as { variant?: string }).variant = sel.modelVariant
    }
    try {
      const res = await backend.client.session.command({
        path: { id: this.sessionID },
        query: { directory: backend.directory },
        body,
      })
      if (res.error) log("command failed", res.error)
    } catch (e) {
      log("command call threw", e)
    }
    // No UI action here — the SSE subscription owns assistant lifecycle.
  }

  /**
   * Dispatch an opencode built-in command to its dedicated session endpoint.
   * `/compact` and `/init` run a server-side turn (rendered via the existing
   * SSE subscription); `/share` and `/unshare` are one-shot actions surfaced
   * through a VS Code notification.
   */
  private async handleBuiltinCommand(command: string) {
    // `/mcp` opens the native MCP management picker — it is NOT a session turn,
    // so it posts no user bubble / Main task and does not ensure a backend here
    // (the command's own handler does). Delegating to the registered command
    // keeps a single source of truth for the picker.
    if (command === "mcp") {
      await vscode.commands.executeCommand("opencui.manageMcp")
      return
    }
    // `/provider` opens the native AI-provider management picker — same
    // no-bubble, no-backend-here contract as `/mcp`.
    if (command === "provider") {
      await vscode.commands.executeCommand("opencui.manageProviders")
      return
    }
    // `/new` starts a fresh chat — no backend needed (the next prompt creates the
    // session lazily), and it must not post a bubble / Main task.
    if (command === "new") {
      await this.newSession()
      return
    }
    let backend: Backend
    try {
      backend = await this.servers.ensure()
    } catch (e) {
      this.post({ type: "connected", connected: false, error: (e as Error).message })
      return
    }
    switch (command) {
      case "compact":
        return this.runCompact(backend)
      case "init":
        return this.runInit(backend)
      case "share":
        return this.runShare(backend)
      case "unshare":
        return this.runUnshare(backend)
      case "undo":
        return this.runUndo(backend)
      case "redo":
        return this.runRedo(backend)
      case "fork":
        return this.runFork(backend)
    }
  }

  /** Post the typed-invocation bubble and key the Agents popover for a built-in turn. */
  private async beginBuiltinTurn(display: string) {
    this.redoStack = [] // a /compact or /init turn diverges the history
    const ctx = getEditorContext()
    const userMessageID = "u_" + Date.now()
    this.pendingUserBackendID = userMessageID
    this.post({
      type: "userMessage",
      id: userMessageID,
      text: display,
      ref: { path: ctx.filePath, label: formatContextHeader(ctx) },
    })
    this.updateTitleFromPrompt(display)
    await this.subagentDispatch.recordMainTaskStart(display)
  }

  private async runCompact(backend: Backend) {
    if (!this.sessionID) {
      void vscode.window.showInformationMessage("Nothing to compact yet.")
      return
    }
    if (!this.subscription) await this.attachSubscription(backend, this.sessionID)
    await this.beginBuiltinTurn("/compact")
    const sel = this.prefs.get()
    const body = sel.modelProviderID && sel.modelID ? { providerID: sel.modelProviderID, modelID: sel.modelID } : undefined
    try {
      const res = await backend.client.session.summarize({
        path: { id: this.sessionID },
        query: { directory: backend.directory },
        body,
      })
      if (res.error) log("compact failed", res.error)
    } catch (e) {
      log("compact threw", e)
    }
  }

  private async runInit(backend: Backend) {
    const sel = this.prefs.get()
    if (!sel.modelProviderID || !sel.modelID) {
      void vscode.window.showWarningMessage("Select a model before running /init.")
      return
    }
    if (!this.sessionID) {
      const created = await backend.client.session.create({ body: {} })
      if (created.error || !created.data) {
        log("session.create failed", created.error)
        return
      }
      this.sessionID = created.data.id
      this.manager.updateActive((conversation) => ({ ...conversation, sessionID: this.sessionID }))
      await this.manager.flushPersist()
      await this.attachSubscription(backend, this.sessionID)
    } else if (!this.subscription) {
      await this.attachSubscription(backend, this.sessionID)
    }
    await this.beginBuiltinTurn("/init")
    try {
      const res = await backend.client.session.init({
        path: { id: this.sessionID },
        query: { directory: backend.directory },
        body: { providerID: sel.modelProviderID, modelID: sel.modelID, messageID: generateMessageID() },
      })
      if (res.error) log("init failed", res.error)
    } catch (e) {
      log("init threw", e)
    }
  }

  private async runShare(backend: Backend) {
    if (!this.sessionID) {
      void vscode.window.showInformationMessage("Start a conversation before sharing.")
      return
    }
    try {
      const res = await backend.client.session.share({
        path: { id: this.sessionID },
        query: { directory: backend.directory },
      })
      if (res.error || !res.data) {
        log("share failed", res.error)
        void vscode.window.showErrorMessage("Failed to share session.")
        return
      }
      const url = res.data.share?.url
      if (!url) {
        void vscode.window.showInformationMessage("Session shared.")
        return
      }
      const pick = await vscode.window.showInformationMessage(`Session shared: ${url}`, "Copy Link")
      if (pick === "Copy Link") await vscode.env.clipboard.writeText(url)
    } catch (e) {
      log("share threw", e)
    }
  }

  private async runUnshare(backend: Backend) {
    if (!this.sessionID) return
    try {
      const res = await backend.client.session.unshare({
        path: { id: this.sessionID },
        query: { directory: backend.directory },
      })
      if (res.error) {
        log("unshare failed", res.error)
        void vscode.window.showErrorMessage("Failed to disable sharing.")
        return
      }
      void vscode.window.showInformationMessage("Session sharing disabled.")
    } catch (e) {
      log("unshare threw", e)
    }
  }

  /**
   * `/undo` — revert the last settled turn. Mirrors handleEdit's
   * revert + truncate + sendConversationState, minus the resend: the removed
   * tail is stashed for `/redo` and the undone prompt is restored to the composer.
   */
  private async runUndo(backend: Backend) {
    if (!this.sessionID) {
      void vscode.window.showInformationMessage("Nothing to undo yet.")
      return
    }
    const idx = lastUserTurnIndex(this.messages)
    if (idx < 0) {
      void vscode.window.showInformationMessage("Nothing to undo.")
      return
    }
    const target = this.messages[idx]!
    try {
      const res = await backend.client.session.revert({
        path: { id: this.sessionID },
        query: { directory: backend.directory },
        body: { messageID: target.backendID! },
      })
      if (res.error) {
        log("undo: session.revert failed", res.error)
        void vscode.window.showErrorMessage("Failed to undo the last turn.")
        return
      }
    } catch (e) {
      log("undo: session.revert threw", e)
      return
    }
    this.redoStack.push(this.messages.slice(idx))
    this.messages = this.messages.slice(0, idx)
    this.reviewHunks = {}
    this.saveActive()
    this.sendConversationState()
    this.queueReviewDecorationsSync()
    // Restore the undone prompt so the user can edit and resend. Plain text only:
    // mentions/attachments are not re-hydrated.
    this.post({ type: "setComposerText", text: userMessageText(target) })
  }

  /** `/redo` — re-apply the most recently undone turn from the in-memory buffer. */
  private async runRedo(backend: Backend) {
    if (!this.sessionID) return
    const tail = this.redoStack.pop()
    if (!tail || tail.length === 0) {
      void vscode.window.showInformationMessage("Nothing to redo.")
      return
    }
    // Move the server revert pointer forward to the next still-reverted tail, or
    // clear it entirely when this restores the latest turn.
    const action = redoAction(this.redoStack[this.redoStack.length - 1])
    try {
      const res =
        action.kind === "revert"
          ? await backend.client.session.revert({
              path: { id: this.sessionID },
              query: { directory: backend.directory },
              body: { messageID: action.messageID },
            })
          : await backend.client.session.unrevert({
              path: { id: this.sessionID },
              query: { directory: backend.directory },
            })
      if (res.error) {
        log("redo failed", res.error)
        void vscode.window.showErrorMessage("Failed to redo.")
        this.redoStack.push(tail)
        return
      }
    } catch (e) {
      log("redo threw", e)
      this.redoStack.push(tail)
      return
    }
    this.messages = [...this.messages, ...tail]
    this.saveActive()
    this.sendConversationState()
    this.queueReviewDecorationsSync()
    this.post({ type: "setComposerText", text: "" })
  }

  /**
   * `/fork` — duplicate the current session into a new conversation. The fork
   * copies the current session, so its history equals our in-memory messages; we
   * adopt the forked session id onto a fresh conversation and copy the messages
   * over (re-stamping their backendIDs from the forked session so revert/edit
   * keep working). No server->ChatMessage converter exists, hence the copy.
   */
  private async runFork(backend: Backend) {
    if (!this.sessionID) {
      void vscode.window.showInformationMessage("Nothing to fork yet.")
      return
    }
    try {
      const res = await backend.client.session.fork({
        path: { id: this.sessionID },
        query: { directory: backend.directory },
        body: {},
      })
      if (res.error || !res.data) {
        log("fork failed", res.error)
        void vscode.window.showErrorMessage("Failed to fork the conversation.")
        return
      }
      const forked = res.data
      const copied = this.messages.map((m) => ({ ...m, pending: false }))
      await this.restampForkedIDs(backend, forked.id, copied)
      const copiedHunks = { ...this.reviewHunks }

      this.resetSessionState()
      const conversation = this.manager.add(forked.title || "Forked chat")
      this.manager.setActiveID(conversation.id)
      this.manager.updateActive((c) => ({ ...c, sessionID: forked.id, messages: copied, reviewHunks: copiedHunks }))
      this.applyActiveSnapshot()
      await this.manager.flushPersist()
      this.sendConversationState()
      this.post({ type: "contextUsage", usage: undefined })
      await this.attachSubscription(backend, forked.id)
      void this.refreshContextUsage(backend)
    } catch (e) {
      log("fork threw", e)
      void vscode.window.showErrorMessage("Failed to fork the conversation.")
    }
  }

  /**
   * Align copied messages' backendIDs with the forked session's real message ids
   * by position. Fork duplicates the whole session, so order + count match (every
   * settled bubble has a server message, and `/fork` only runs when idle); if the
   * counts diverge we keep the copied ids and log — edit/undo on a pre-fork message
   * may then need a fresh turn first.
   */
  private async restampForkedIDs(backend: Backend, sessionID: string, messages: ChatMessage[]) {
    try {
      const res = await backend.client.session.messages({
        path: { id: sessionID },
        query: { directory: backend.directory },
      })
      const server = (res.data ?? []) as Array<{ info?: { id?: string } }>
      if (res.error || server.length !== messages.length) {
        log("fork: skipping backendID re-stamp", { error: res.error, server: server.length, local: messages.length })
        return
      }
      messages.forEach((m, i) => {
        const id = server[i]?.info?.id
        if (id) m.backendID = id
      })
    } catch (e) {
      log("fork: restamp threw", e)
    }
  }

  private async handleEdit(webviewID: string, text: string, mentions?: string[], attachments?: Attachment[], conversationMentions?: string[]) {
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

    await this.handleSend(trimmed, mentions, attachments, conversationMentions)
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
        this.continuationState.finishPending()
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
          void this.subagentDispatch.recordMainTaskFinish(classified.status, classified.error)
        }
        this.post({ type: "assistantDone", id: webviewID, usage: payload.usage })
        void this.refreshContextUsage(backend)
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
        void this.subagentDispatch.forwardTool(update, mid)
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
        void this.refreshContextUsage(backend)
      },
      onToast: (toast) => this.surfaceToast(toast),
      onSessionError: (message) => {
        log("session error", message)
        // A parent session.error that isn't mirrored by an assistant-message
        // error (that case is handled in onAssistantEnd) would otherwise fail
        // silently AND let the trailing session.idle's markSessionIdle sweep the
        // Agents-popover Main row to "completed". Settle the Main task first so
        // the terminal guard protects its status, then surface the failure.
        // A server-side abort ("Aborted") settles quietly — mirroring the chat
        // bubble's Stopped convention — instead of flashing a red toast.
        const classified = classifyTerminal(message)
        void this.subagentDispatch.recordMainTaskFinish(classified.status, classified.error)
        if (classified.status === "error") {
          this.surfaceToast({
            variant: "error",
            title: "Session error",
            message: message || "The session reported an error.",
          })
        }
      },
      onSessionBusy: () => {
        // A new busy state means continuation (if any) took over — cancel
        // any pending idle so we don't accidentally clear busy later.
        this.continuationState.finishPending()
        this.post({ type: "sessionBusy" })
      },
      onSessionIdle: () => {
        const wasAborting = this.aborting
        this.aborting = false
        if (wasAborting) {
          // User-initiated abort bypasses the continuation defer — Stop
          // means stop now. Clear all continuation tracking so any
          // in-flight task parts (whose terminal events the SSE may not
          // send post-abort) don't poison the next turn. `abortCurrent`
          // already ran `cancelForSession` proactively; this is the
          // catch-all that covers any dispatch that snuck in between
          // the snapshot there and the session.idle arriving here.
          this.resetSessionTracking()
          if (this.sessionID) {
            if (this.subagentTracker) {
              void this.subagentTracker.cancelForSession(this.sessionID)
            } else if (this.taskStore) {
              void this.taskStore.cancelSessionTasks(this.sessionID)
            }
          }
          this.subagentDispatch.clearMainTaskID()
          this.post({ type: "sessionIdle" })
          void this.manager.flushPersist()
          return
        }
        if (this.continuationState.hasGate()) {
          this.continuationState.beginDefer("sessionIdle")
          return
        }
        this.continuationState.finishPending()
        if (this.sessionID && this.taskStore) {
          void this.taskStore.markSessionIdle(this.sessionID)
        }
        this.subagentDispatch.clearMainTaskID()
        this.post({ type: "sessionIdle" })
        void this.manager.flushPersist()
      },
      onChildSessionEvent: (event) => {
        if (this.aborting) return
        // Route tool / patch events through the review-card pipeline FIRST so
        // the subagent's file changes show up in the panel even if the tracker
        // then decides to settle the row. The tracker's handleChildSessionEvent
        // ignores tool/patch variants so this isn't double-handling.
        if (event.type === "tool" || event.type === "patch") {
          this.appendSubagentBlock(event, backend.directory)
        }
        if (!this.subagentTracker) return
        void this.subagentTracker.handleChildSessionEvent(event).then(() => {
          // After any child terminal event, if we were deferring an
          // idle waiting on subagents and the store is now empty,
          // arm the short grace timer.
          this.continuationState.collapseToGraceIfSettled()
        })
      },
      onSessionTitleUpdate: (title) => {
        this.manager.rename(this.manager.getActiveID(), title)
        this.manager.schedulePersist()
        this.postConversationsList()
      },
      onChildSessionDiscovered: (info) => {
        if (this.aborting) return
        // Register for SSE routing IMMEDIATELY so we don't miss the child's
        // first tool/patch events while we wait for the parent's task tool
        // metadata to surface the child sessionID. Cheap idempotent add.
        subscription.addChildSession(info.id)
        if (!this.subagentTracker) return
        void this.subagentTracker.registerChildSession(info)
      },
    })
    this.subscription = subscription
    if (this.taskStore) {
      this.subagentTracker = new SubagentTracker({
        store: this.taskStore,
        getActiveConversationID: () => this.manager.getActiveID(),
        getParentSessionID: () => this.sessionID,
        subscription: {
          addChildSession: (id) => subscription.addChildSession(id),
          removeChildSession: (id) => subscription.removeChildSession(id),
        },
      })
      this.subagentDispatch.setTracker(this.subagentTracker)
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
    // Refresh the command list on every (re)connect — picks up newly-added
    // command files and survives an opencode server restart.
    void this.refreshCommands(backend)
  }

  private ensureWebviewID(opencodeID: string): string {
    const existing = this.messageMap.get(opencodeID)
    if (existing) return existing
    const webviewID = "a_" + opencodeID
    this.messageMap.set(opencodeID, webviewID)
    this.post({ type: "assistantStart", id: webviewID })
    return webviewID
  }

  /**
   * Route a subagent's tool/patch event into the chat record + Review Panel.
   *
   * The parent webview message is located by walking back from the child
   * session's task (stored under `subagent:child:<childSessionID>` in the
   * task store, which carries the dispatching parent assistant message ID).
   * If that lookup fails, fall back to the most-recent assistant message in
   * the conversation — the user still gets the change in the review card,
   * just attached one bubble higher than ideal.
   */
  private appendSubagentBlock(
    event:
      | { type: "tool"; sessionID: string; messageID: string; update: ToolUpdate }
      | { type: "patch"; sessionID: string; messageID: string; files: string[]; diff?: string },
    cwd: string,
  ): void {
    const actor = this.resolveSubagentActor(event.sessionID)
    const parentWebviewID = this.locateParentWebviewID(event.sessionID)
    if (!parentWebviewID) {
      log(`[review] dropping ${event.type} from child ${event.sessionID} — no parent message in view`)
      return
    }
    if (event.type === "tool") {
      const wire = toWire(event.update, cwd)
      this.post({ type: "tool", id: parentWebviewID, update: wire, actor })
      this.queueReviewDecorationsSync()
      return
    }
    this.post({
      type: "patch",
      id: parentWebviewID,
      files: event.files.map((f) => relativeToCwd(cwd, f)),
      diff: event.diff,
      actor,
    })
    this.queueReviewDecorationsSync()
  }

  private resolveSubagentActor(childSessionID: string) {
    const task = this.taskStore?.getByChildSession(childSessionID)
    return {
      kind: "subagent" as const,
      sessionID: childSessionID,
      subagent: task?.subagent,
    }
  }

  /**
   * Look up which parent assistant message a child session belongs to. The
   * AgentTaskStore tracks the dispatching `messageID` per subagent task;
   * combined with `this.messageMap` (backend → webview ID) we land on the
   * right bubble. Fallback: the most-recent assistant message in the view.
   */
  private locateParentWebviewID(childSessionID: string): string | undefined {
    const task = this.taskStore?.getByChildSession(childSessionID)
    if (task?.messageID) {
      const mapped = this.messageMap.get(task.messageID)
      if (mapped) return mapped
    }
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]!
      if (message.role === "assistant") return message.id
    }
    return undefined
  }

  private async openReviewChange(change: ReviewChange) {
    if (!isTextReviewPath(change.path)) {
      vscode.window.showWarningMessage(`OpenCode Panel: ${change.path} cannot be reviewed as text.`)
      return
    }
    try {
      const root = this.backendDirectory()
      const doc = await openFileDocument(change.path, root)
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
    const root = this.backendDirectory()
    for (const change of changes) {
      if (seen.has(change.path)) continue
      seen.add(change.path)
      // Never purge created files — they were just written and may not yet be
      // visible to the VS Code file-system API, or the workspace may not cover
      // the path. Purging here would permanently hide the review card.
      if (change.kind === "created") continue
      // A `deleted` change is SUPPOSED to leave the file gone — don't purge it
      // either; that's the desired post-change state and the user might still
      // want to Undo (restoring it) or Keep (confirming the delete).
      if (change.kind === "deleted") continue
      if (await reviewPathExists(change.path, root)) continue
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
    // The webview's review row is keyed on the AGGREGATED change (one row per
    // path), but the action must iterate the UN-aggregated per-tool records:
    // `aggregateChanges` keeps only the LAST contributing record's `patch`,
    // so acting on the aggregated patch alone would silently miss every
    // earlier tool call's hunks. We pass both into the pure helper — records
    // drive the fs ops, the aggregated row drives the UI state updates.
    const aggregatedAll = reviewChanges(this.messages)
    const aggregated = aggregatedAll.find((c) => samePath(c.path, requestedPath))
    if (!aggregated) {
      log("reviewAllInChange: no matching change", { source, path: requestedPath, available: aggregatedAll.map((c) => c.path) })
      return
    }
    const records = extractChanges(this.messages).filter((c) => samePath(c.path, requestedPath))
    if (!records.length) {
      log("reviewAllInChange: aggregated row has no underlying records", { source, path: requestedPath })
      return
    }
    const root = this.backendDirectory()
    const result = await reviewAllForPath(records, aggregated, action, {
      root,
      reviewedKeys: this.reviewHunks,
    })
    for (const update of result.hunkUpdates) {
      this.post({ type: "reviewHunkState", key: update.key, state: update.state })
    }
    if (result.conflicts > 0) {
      const verb = action === "accepted" ? "accept" : "undo"
      vscode.window.showWarningMessage(
        `OpenCode Panel: couldn't ${verb} ${result.conflicts} hunk${result.conflicts === 1 ? "" : "s"} in ${requestedPath} — the file has changed since the diff was produced.`,
      )
    }
    if (result.applied > 0) await this.syncReviewDecorations()
    else log("reviewAllInChange: no hunks applied", { source, path: requestedPath, action, conflicts: result.conflicts })
  }

  private backendDirectory(): string | undefined {
    return this.servers.currentWorkspace()?.fsPath
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

  // The popover shows ONLY currently-active work — main tasks and any
  // subagents whose status is in ATTENTION_STATUSES. `completed` and
  // `cancelled` rows are dropped so the popover reflects "what's happening
  // right now," not a per-chat history. A second user prompt gets its own
  // main row (see mainTaskID's per-turn keying); the prior turn's row is
  // settled and filtered out.
  const counts: Record<AttentionStatus, number> = Object.fromEntries(
    ATTENTION_STATUSES.map((status) => [status, 0]),
  ) as Record<AttentionStatus, number>
  const items: AgentsTaskInfo[] = []
  for (const task of scoped) {
    if (!isAttentionStatus(task.status)) continue
    counts[task.status] += 1
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
  return {
    running: counts.running,
    waiting: counts.waiting,
    error: counts.error,
    total: counts.running + counts.waiting + counts.error,
    tasks: items,
  }
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

type ContextUsageMessageInfo = {
  role?: string
  providerID?: string
  modelID?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

type ContextUsageMessage = { info?: ContextUsageMessageInfo }
type ContextUsageProvider = {
  id?: string
  models?: Record<string, { limit?: { context?: number } } | undefined>
}

// Provider metadata (model context limits) changes only when the user edits
// their opencode config, but readContextUsage runs after every turn. Cache it
// per backend with a short TTL so the indicator stops re-fetching it each turn.
type CachedProviders = { providers: ContextUsageProvider[]; at: number }
const providersCache = new Map<string, CachedProviders>()
const PROVIDERS_CACHE_MS = 5 * 60 * 1000

async function fetchProviders(backend: Backend): Promise<ContextUsageProvider[]> {
  const now = Date.now()
  const cached = providersCache.get(backend.url)
  if (cached && now - cached.at < PROVIDERS_CACHE_MS) return cached.providers
  const res = await backend.client.config.providers()
  if (res.error) {
    if (cached) return cached.providers
    throw new Error(`config.providers failed: ${JSON.stringify(res.error)}`)
  }
  const providers = (res.data as { providers?: ContextUsageProvider[] } | undefined)?.providers ?? []
  providersCache.set(backend.url, { providers, at: now })
  return providers
}

async function readContextUsage(backend: Backend, sessionID: string): Promise<ContextUsage | undefined> {
  const [messagesRes, providers] = await Promise.all([
    backend.client.session.messages({
      path: { id: sessionID },
      query: { directory: backend.directory, limit: 100 },
    }),
    fetchProviders(backend),
  ])
  if (messagesRes.error) throw new Error(`session.messages failed: ${JSON.stringify(messagesRes.error)}`)

  const messages = (messagesRes.data ?? []) as ContextUsageMessage[]
  return contextUsageFromMessages(messages, providers)
}

export function contextUsageFromMessages(
  messages: ContextUsageMessage[],
  providers: ContextUsageProvider[],
): ContextUsage | undefined {
  const last = messages.findLast((item) =>
    item.info?.role === "assistant" && numberOrZero(item.info.tokens?.output) > 0
  )
  if (!last?.info?.tokens) return undefined

  const tokens = contextTokenCount(last.info.tokens)
  if (tokens <= 0) return undefined

  const providerID = last.info.providerID
  const modelID = last.info.modelID
  const limit = findContextLimit(providers, providerID, modelID)
  const cost = messages.reduce((sum, item) => {
    const info = item.info
    return info?.role === "assistant" && typeof info.cost === "number" ? sum + info.cost : sum
  }, 0)
  return {
    tokens,
    limit,
    percent: limit ? Math.round((tokens / limit) * 100) : undefined,
    model: providerID && modelID ? `${providerID}/${modelID}` : undefined,
    cost: cost > 0 ? cost : undefined,
  }
}

function contextTokenCount(tokens: NonNullable<ContextUsageMessageInfo["tokens"]>): number {
  return (
    numberOrZero(tokens.input) +
    numberOrZero(tokens.output) +
    numberOrZero(tokens.reasoning) +
    numberOrZero(tokens.cache?.read) +
    numberOrZero(tokens.cache?.write)
  )
}

function findContextLimit(
  providers: ContextUsageProvider[],
  providerID: string | undefined,
  modelID: string | undefined,
): number | undefined {
  if (!providerID || !modelID) return undefined
  const value = providers.find((provider) => provider.id === providerID)?.models?.[modelID]?.limit?.context
  return typeof value === "number" && value > 0 ? value : undefined
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function upsertTool(
  messages: ChatMessage[],
  id: string,
  update: WireToolUpdate,
  actor?: ReviewChangeActor,
): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== id) return message
    const existing = message.blocks.findIndex((b) => b.type === "tool" && b.update.callID === update.callID)
    if (existing >= 0) {
      const blocks = message.blocks.slice()
      const prev = blocks[existing]
      blocks[existing] = {
        type: "tool",
        update,
        actor: actor ?? (prev.type === "tool" ? prev.actor : undefined),
      }
      return { ...message, blocks }
    }
    return { ...message, blocks: [...message.blocks, { type: "tool", update, actor }] }
  })
}
