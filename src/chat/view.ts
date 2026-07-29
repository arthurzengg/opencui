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
import { pickAttachments, bytesToDataUrl } from "../attachments"
import { AttachmentStore, dataUrlToBytes } from "./attachment-store"
import { log } from "../output"
import { getWorkspaceRoots, primaryWorkspaceRoot } from "../workspace-root"
import type { WorkspaceInfo } from "../protocol"
import type {
  Attachment,
  ChatBlock,
  ChatMessage,
  CommandInfo,
  ConversationMention,
  Inbound,
  Outbound,
  ToolUpdate as WireToolUpdate,
  Selection,
  ReviewChange,
  ReviewChangeActor,
  ReviewHunkState,
} from "../protocol"
import { BUILTIN_COMMAND_NAMES, withBuiltinCommands } from "./builtin-commands"
import { BuiltinRunners } from "./builtin-runners"
import { readContextUsage } from "./context-usage"
import { adoptStorageIDs, migrateConversationsToWorkspace } from "./conversation-store"
import { ConversationManager } from "./conversation-manager"
import { ContinuationState, isContinuationToast } from "./continuation-state"
import { sweepAbortTree, drainAbortTree } from "./abort-tree"
import { SubagentDispatch } from "./subagent-dispatch"
import { relativeToCwd, samePath } from "./paths"
import { reviewKey, splitReviewDiff } from "./diff"
import { extractChanges, isTextReviewPathName, reviewChanges } from "./review-changes"
import { reviewAllForPath } from "./review-actions"
import { attachableConversationIDs, buildPrompt, readMentions, readConversationMentions } from "./prompt-builder"
import { buildManifest } from "../workspace-context/manifest"
import { collectAutoContext } from "../workspace-context/collector"
import { RecentEditsTracker } from "../workspace-context/recent-edits"
import { readContextSettings } from "../workspace-context/budget"
import type { IndexManager } from "../indexing/index-manager"
import { AgentTaskStore, classifyTerminal, type AgentTask } from "../agents/task-store"
import { summarizeAgentTasks } from "../agents/summary"
import { SubagentTracker } from "../agents/subagent-tracker"
import { toWire } from "./wire-format"
import {
  applyCode,
  openFile,
  openFileDocument,
  revealDocument,
  reviewPathExists,
} from "./fs-ops"

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
  /** Minimum gap between automatic SSE re-attach attempts after stream loss. */
  private static readonly STREAM_REATTACH_MIN_MS = 10_000
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
   * Implementations of the backend-bound built-in slash commands
   * (`/compact`, `/init`, `/share`, `/unshare`, `/undo`, `/redo`,
   * `/fork`). See {@link BuiltinRunners}.
   */
  private builtinRunners: BuiltinRunners
  /**
   * Single per-conversation subagent state machine. Reset on
   * `createConversation` / `selectConversation` / `dispose`. Constructed
   * lazily inside `attachSubscription` because the SSE subscription's
   * `addChildSession` / `removeChildSession` are the wiring it depends
   * on — both don't exist until we have a session to subscribe to.
   */
  private subagentTracker?: SubagentTracker
  /** Disk home for attachment bytes; conversation state keeps references only. */
  private attachmentStore: AttachmentStore

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
    this.attachmentStore = new AttachmentStore(context.storageUri ?? context.globalStorageUri)
    this.subagentDispatch = new SubagentDispatch({
      taskStore: this.taskStore,
      getSessionID: () => this.sessionID,
      getActiveConversationID: () => this.manager.getActiveID(),
      collapseToGraceIfSettled: () => this.continuationState.collapseToGraceIfSettled(),
    })
    this.continuationState = new ContinuationState({
      post: (msg) => this.post(msg),
      activeSubagentCount: () => this.subagentDispatch.activeSubagentCount(),
      emitIdle: () => this.settleSessionIdle(),
    })
    this.builtinRunners = new BuiltinRunners({
      prefs: this.prefs,
      manager: this.manager,
      getSessionID: () => this.sessionID,
      setSessionID: (id) => {
        this.sessionID = id
      },
      hasSubscription: () => this.subscription !== undefined,
      attachSubscription: (backend, sessionID) => this.attachSubscription(backend, sessionID),
      beginBuiltinTurn: (display) => this.beginBuiltinTurn(display),
      failTurn: (message) => this.failTurnUnstick(message, "Command failed"),
      post: (msg) => this.post(msg),
      getMessages: () => this.messages,
      setMessages: (messages) => {
        this.messages = messages
      },
      getRedoStack: () => this.redoStack,
      getReviewHunks: () => this.reviewHunks,
      clearReviewHunks: () => {
        this.reviewHunks = {}
      },
      saveActive: () => this.saveActive(),
      sendConversationState: () => this.sendConversationState(),
      resetSessionState: () => this.resetSessionState(),
      applyActiveSnapshot: () => this.applyActiveSnapshot(),
      refreshContextUsage: (backend) => this.refreshContextUsage(backend),
    })
    this.applyActiveSnapshot()
    void this.manager.persist()
    if (this.taskStore) {
      this.taskStoreUnsub = this.taskStore.onDidChange((tasks) => this.postAgentsStatus(tasks))
    }
  }

  /**
   * The full end-of-turn settlement: settle the session's task rows, drop
   * the per-turn Main task ID, tell the webview, persist. Shared by the
   * direct `session.idle` path and ContinuationState's deferred-idle timers —
   * the deferred path once posted only `sessionIdle`, leaving the Main row
   * `running` in workspaceState forever.
   */
  private settleSessionIdle() {
    if (this.sessionID && this.taskStore) {
      void this.taskStore.markSessionIdle(this.sessionID)
    }
    // A pending permission/question cannot outlive its turn — opencode
    // blocks the turn on it. An entry surviving here would wedge the NEXT
    // turn's Main row on `waiting` (syncAgentWaitState counts these maps).
    this.activePermissions.clear()
    this.activeQuestions.clear()
    this.subagentDispatch.clearMainTaskID()
    this.post({ type: "sessionIdle" })
    void this.manager.flushPersist()
  }

  private postAgentsStatus(tasks: AgentTask[]) {
    const activeID = this.manager.getActiveID()
    const status = summarizeAgentTasks(tasks, activeID)
    log(
      `[agents-status] post snapshot conv=${activeID} total=${status.total} (running=${status.running} waiting=${status.waiting} error=${status.error}) ids=[${status.tasks.map((t) => `${t.kind}:${t.id}`).join(", ")}]`,
    )
    this.post({ type: "agentsStatus", status })
  }

  /**
   * Recompute "is this turn blocked on the user?" from the pending
   * permission + question maps and mirror it onto the Main task row.
   * Must be called after every mutation of either map — the popover
   * renders `waiting` as "waiting for input", and before this wiring
   * nothing ever set that status, so a permission-blocked turn showed
   * as `running`.
   */
  private syncAgentWaitState() {
    const pending = this.activePermissions.size + this.activeQuestions.size
    void this.subagentDispatch.setMainWaiting(pending > 0)
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
      this.queueReviewHunkSync()
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

  private webviewMounted = false

  /**
   * Test-facing snapshot exposed through the extension's `activate()` exports.
   * `resolved` — VS Code called resolveWebviewView; `mounted` — the bundled
   * React app booted inside the webview and completed the `mounted` handshake.
   * The integration suite polls this to prove the real webview loads end to
   * end (CSP, bundle, protocol) — something no unit test can observe.
   */
  webviewState(): { resolved: boolean; mounted: boolean } {
    return { resolved: this.view !== undefined, mounted: this.webviewMounted }
  }

  async newSession() {
    await this.createConversation()
  }

  async createConversation() {
    this.resetSessionState()
    // Reuse an existing untouched "New conversation" (active or anywhere in
    // the list) so New-chat clicks switch to that empty chat instead of
    // piling up duplicates.
    const { conversation } = this.manager.addOrReuseEmpty("New conversation")
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
    this.clearPendingDeltas()
    if (this.reviewSyncTimer) {
      clearTimeout(this.reviewSyncTimer)
      this.reviewSyncTimer = undefined
    }
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
    // Any non-delta message flushes buffered deltas first so nothing (tool
    // closures, sessionIdle, aborted…) can overtake text that arrived
    // before it. flushDeltas() itself posts delta-typed messages, so this
    // guard is also the recursion stop.
    if (msg.type !== "textDelta" && msg.type !== "reasoningDelta") this.flushDeltas()
    this.applyLocal(msg)
    this.view?.webview.postMessage(msg)
  }

  /**
   * Host-side token coalescing: streamed text/reasoning deltas buffer here
   * for up to DELTA_FLUSH_MS and go out as one post per (kind, message)
   * pair. Every delta used to cost its own webview IPC message plus an
   * applyLocal pass (message-array rebuild + conversation snapshot); at fast
   * token rates that work now happens ~40×/s instead of per token. The
   * webview's own per-frame coalescer sits downstream, unchanged.
   */
  private pendingDeltas = new Map<string, { type: "textDelta" | "reasoningDelta"; id: string; delta: string }>()
  private deltaFlushTimer?: ReturnType<typeof setTimeout>
  private static readonly DELTA_FLUSH_MS = 25

  private queueDelta(type: "textDelta" | "reasoningDelta", id: string, delta: string) {
    const key = `${type}:${id}`
    const pending = this.pendingDeltas.get(key)
    if (pending) pending.delta += delta
    else this.pendingDeltas.set(key, { type, id, delta })
    this.deltaFlushTimer ??= setTimeout(() => this.flushDeltas(), ChatView.DELTA_FLUSH_MS)
  }

  private flushDeltas() {
    if (this.deltaFlushTimer) {
      clearTimeout(this.deltaFlushTimer)
      this.deltaFlushTimer = undefined
    }
    if (!this.pendingDeltas.size) return
    const batch = [...this.pendingDeltas.values()]
    this.pendingDeltas.clear()
    for (const d of batch) this.post({ type: d.type, id: d.id, delta: d.delta })
  }

  /** Drop (not flush) buffered deltas — for teardown paths where posting
   *  them would leak stream content into a switched/disposed view. */
  private clearPendingDeltas() {
    if (this.deltaFlushTimer) {
      clearTimeout(this.deltaFlushTimer)
      this.deltaFlushTimer = undefined
    }
    this.pendingDeltas.clear()
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
    this.clearPendingDeltas()
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
    await this.inflateActiveAttachments()
    await this.manager.flushPersist()
    this.sendConversationState()
    this.post({ type: "contextUsage", usage: undefined })
    if (this.sessionID) void this.refreshContextUsage()
    if (this.taskStore) this.postAgentsStatus(this.taskStore.list())
    this.reconcileOnConversationEntry()
  }

  /**
   * Settle stale task rows when the user lands on a conversation without
   * sending anything. attachSubscription's reconcile only runs on send
   * paths, and switching away aborts the SSE subscription but not the
   * server-side turn — so a conversation abandoned mid-turn kept its rows
   * `running` (pulsing pill, growing timers) until the next send here.
   * Uses a throwaway tracker with a no-op subscription: there is no live
   * stream to resume still-busy children into, so genuinely-busy sessions
   * keep their rows running (truthful) and idle/absent ones settle. Only
   * consults an already-running backend — never cold-starts one.
   */
  private reconcileOnConversationEntry(): void {
    if (!this.taskStore || !this.sessionID) return
    const backend = this.servers.currentBackend()
    if (!backend) return
    const sessionID = this.sessionID
    const tracker = new SubagentTracker({
      store: this.taskStore,
      getActiveConversationID: () => this.manager.getActiveID(),
      getParentSessionID: () => sessionID,
      subscription: { addChildSession: () => {}, removeChildSession: () => {} },
    })
    void tracker.reconcile(backend, sessionID)
  }

  /** Active conversation ID for host-side consumers outside the webview (agents QuickPick). */
  activeConversationID(): string {
    return this.manager.getActiveID()
  }

  private async renameConversation(id: string, title: string) {
    this.manager.rename(id, title)
    await this.manager.flushPersist()
    this.postConversationsList()
  }

  private async deleteConversation(id: string) {
    const wasActive = this.manager.getActiveID() === id
    const removedStorageIDs = this.manager.storageIDs(id)
    this.manager.remove(id)
    // Drop the deleted conversation's task history so the popover
    // doesn't carry forward rows the user can no longer trace back to
    // anything. Best-effort; failures here aren't fatal.
    if (this.taskStore) {
      void this.taskStore.clearForConversation(id)
    }
    // GC attachment bytes nothing references anymore. Best-effort: a file
    // that survives a failed delete is orphaned disk, not broken state.
    if (removedStorageIDs.length) {
      const remaining = this.manager.allStorageIDs()
      for (const storageID of removedStorageIDs) {
        if (!remaining.has(storageID)) void this.attachmentStore.delete(storageID)
      }
    }
    if (wasActive) {
      this.resetSessionState()
      this.manager.setActiveID(this.manager.summaries()[0]!.id)
      this.applyActiveSnapshot()
      await this.inflateActiveAttachments()
      await this.manager.flushPersist()
      this.sendConversationState()
      this.post({ type: "contextUsage", usage: undefined })
      if (this.sessionID) void this.refreshContextUsage()
      this.reconcileOnConversationEntry()
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

  /**
   * One-shot per mount: move legacy inline-base64 attachments into the
   * attachment store (so `persist()` can strip them) and re-inflate image
   * previews for storage-backed blocks. Runs before the restore post so the
   * webview's first paint has its thumbnails. Idempotent — after the first
   * migration there are no legacy blocks left, and inflation skips blocks
   * that already carry a dataUrl.
   */
  private async prepareStoredAttachments() {
    try {
      const migrated = await this.manager.migrateAttachments((bytes) => this.attachmentStore.save(bytes))
      if (migrated) {
        const active = this.manager.getMessages(this.manager.getActiveID()) ?? []
        this.messages = adoptStorageIDs(this.messages, active)
        this.saveActive()
      }
      await this.inflateActiveAttachments()
    } catch (e) {
      log("attachment migration/inflation failed", e)
    }
  }

  /**
   * Storage-backed image blocks persist without their base64 copy; the
   * webview's `<img>` previews need it back after a restore. Non-images
   * render as filename chips and never need bytes, so only image/* blocks
   * are read. Missing/empty files leave the block as-is (the thumbnail
   * falls back to a file icon).
   */
  private async inflateActiveAttachments() {
    const needsInflate = (b: ChatBlock) =>
      b.type === "attachment" && Boolean(b.storageID) && !b.dataUrl && b.mime.startsWith("image/")
    let changed = false
    const messages = await Promise.all(
      this.messages.map(async (m) => {
        if (!m.blocks.some(needsInflate)) return m
        const blocks = await Promise.all(
          m.blocks.map(async (b) => {
            if (!needsInflate(b) || b.type !== "attachment") return b
            const bytes = await this.attachmentStore.read(b.storageID!)
            if (!bytes || bytes.byteLength === 0) return b
            changed = true
            return { ...b, dataUrl: bytesToDataUrl(b.mime, bytes) }
          }),
        )
        return { ...m, blocks }
      }),
    )
    if (changed) this.messages = messages
  }

  /**
   * Write new attachment bytes into the attachment store and patch the
   * just-posted user message's blocks with the resulting storageIDs so the
   * persist layer can strip the inline base64. Attachments already carrying
   * a storageID (edit/retry resends) are reused without rewriting; a failed
   * save falls back to legacy inline persistence for that attachment.
   */
  private async stashAttachments(
    messageID: string,
    attachments?: Attachment[],
  ): Promise<Attachment[] | undefined> {
    if (!attachments?.length) return attachments
    const stored = await Promise.all(
      attachments.map(async (a) => {
        if (a.storageID || !a.dataUrl) return a
        const bytes = dataUrlToBytes(a.dataUrl)
        if (!bytes) return a
        const storageID = await this.attachmentStore.save(bytes)
        return storageID ? { ...a, storageID } : a
      }),
    )
    if (stored.some((a, i) => a !== attachments[i])) {
      this.messages = this.messages.map((m) => {
        if (m.id !== messageID) return m
        // applyLocal built the attachment blocks in `attachments` order
        // (before the text block), so a running index maps block -> source.
        let idx = 0
        return {
          ...m,
          blocks: m.blocks.map((b) =>
            b.type === "attachment" ? { ...b, storageID: stored[idx++]?.storageID ?? b.storageID } : b,
          ),
        }
      })
      this.saveActive()
    }
    return stored
  }

  /**
   * Resolve the URL opencode receives for an attachment file part:
   * the original on-disk file when we still know it, else our stored copy,
   * else the inline data URL (legacy conversations only).
   */
  private attachmentPartUrl(a: Attachment): string | undefined {
    if (a.sourcePath) return vscode.Uri.file(a.sourcePath).toString()
    if (a.storageID) {
      const uri = this.attachmentStore.uriFor(a.storageID)
      if (uri) return uri.toString()
    }
    return a.dataUrl
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
        this.queueReviewHunkSync()
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
              storageID: a.storageID,
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
      case "assistantSummary":
        this.messages = this.messages.map((m) => (m.id === msg.id ? { ...m, summary: true } : m))
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
        // Only a completed tool can change the review set — extractChanges
        // skips every other status, so pending/running ticks would sync for
        // nothing.
        if (msg.update.status === "completed") this.queueReviewHunkSync()
        return
      case "patch":
        this.messages = this.messages.map((m) =>
          m.id === msg.id
            ? { ...m, blocks: [...m.blocks, { type: "patch", files: msg.files, diff: msg.diff, actor: msg.actor }] }
            : m,
        )
        this.saveActive()
        this.queueReviewHunkSync()
        return
      case "reviewHunkState":
        this.reviewHunks = { ...this.reviewHunks }
        if (msg.state) this.reviewHunks[msg.key] = msg.state
        else delete this.reviewHunks[msg.key]
        this.saveActive()
        this.queueReviewHunkSync()
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
        this.webviewMounted = true
        this.post({
          type: "ready",
          connected: false,
          selection: this.buildSelection(),
        })
        await this.prepareStoredAttachments()
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
      case "openExternal":
        // The webview only ever sends regex-matched http(s) URLs, but this is
        // a trust boundary — re-check the scheme so no other kind of URI can
        // reach openExternal through a forged message.
        if (/^https?:\/\//i.test(msg.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url))
        }
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
        this.syncAgentWaitState()
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
        this.syncAgentWaitState()
        await this.replyQuestion(msg.id, msg.answers)
        return
      }
      case "questionReject": {
        this.activeQuestions.delete(msg.id)
        this.syncAgentWaitState()
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
    // The webview reducer drops its permission/question dialogs on
    // `aborted`; mirror that here or the dead prompts wedge the next
    // turn's waiting computation in syncAgentWaitState.
    this.activePermissions.clear()
    this.activeQuestions.clear()
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
    // Each Stop is a fresh generation: sessions aborted by a PREVIOUS Stop
    // must be re-abortable, or a second Stop in the same conversation skips
    // the root entirely and the server keeps generating.
    this.abortedTree.clear()
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
      const state = { aborted: this.abortedTree, isLive: () => gen === this.abortGen }
      await sweepAbortTree(backend.client, sessionID, childSessionIDs, state)
      // Bounded safety net from the original design: with traversal gated on
      // the aborted set, a pass after a complete sweep terminates at the root
      // and goes quiet. Stop is one volley — the drain must NOT re-hunt the
      // tree, or it kills sessions spawned after Stop (see sweepAbortTree).
      void drainAbortTree(backend.client, sessionID, state, {
        passes: ChatView.ABORT_DRAIN_PASSES,
        intervalMs: ChatView.ABORT_DRAIN_INTERVAL_MS,
      })
    } catch (e) {
      log("session.abort failed", e)
    }
    // Do NOT close SSE — opencode will emit the final events telling us the
    // assistant message ended (session.idle clears this.aborting).
  }

  /**
   * Session ids aborted in the current Stop generation, shared by the initial
   * sweep and the background drain so they don't re-abort the same node.
   * Cleared in `abortCurrent` when a new generation starts — a stale entry
   * would make the next Stop skip the session entirely.
   */
  private abortedTree = new Set<string>()
  /**
   * Monotonic token identifying the current Stop. Bumped on each
   * `abortCurrent` and on each new user turn (`handleSend`) so a background
   * drain loop from a previous Stop cannot abort sessions belonging to work
   * the user has since restarted.
   */
  private abortGen = 0

  private async handleSend(text: string, mentions?: string[], attachments?: Attachment[], conversationMentions?: ConversationMention[]) {
    // A new turn supersedes any in-flight abort drain from a prior Stop so it
    // can't abort the session tree the new turn is about to (re)use.
    this.abortGen++
    this.redoStack = [] // a new turn diverges the history; nothing to redo
    const ctx = getEditorContext()
    const label = formatContextHeader(ctx)
    const userMessageID = "u_" + Date.now()
    // The message persists every chip pair as written — the edit flow rebuilds
    // label→id bindings from them. Self-mentions and duplicate chips are
    // filtered out of what the PROMPT attaches, never out of the message.
    const attachedConversationIDs = attachableConversationIDs(
      conversationMentions,
      this.manager.getActiveID(),
    )
    this.pendingUserBackendID = userMessageID
    this.post({
      type: "userMessage",
      id: userMessageID,
      text,
      ref: { path: ctx.filePath, label },
      attachments,
      mentions,
      conversationMentions: conversationMentions?.length ? conversationMentions : undefined,
    })
    this.updateTitleFromPrompt(text)
    // After the optimistic bubble post (attachment writes must not delay the
    // user's message appearing) but before the prompt parts are built, which
    // prefer the stored copy over inline base64.
    const storedAttachments = await this.stashAttachments(userMessageID, attachments)

    let backend: Backend
    try {
      backend = await this.servers.ensure()
    } catch (e) {
      this.post({ type: "connected", connected: false, error: (e as Error).message })
      this.failSend((e as Error).message || "Could not start the opencode server.")
      return
    }

    if (!this.sessionID) {
      const sessionID = await this.createSessionForSend(backend)
      if (!sessionID) return
      this.sessionID = sessionID
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
      attachedConversationIDs,
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
        status: info.truncated ? "truncated" : "included",
        bytes: info.included,
      })
      manifest.totals.includedItems += 1
      manifest.totals.includedBytes += info.included
      if (info.truncated) manifest.totals.truncatedItems += 1
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
    if (storedAttachments) {
      for (const a of storedAttachments) {
        const url = this.attachmentPartUrl(a)
        if (!url) {
          log("attachment has no resolvable source, skipping part", a.filename)
          continue
        }
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
        this.failSend("opencode rejected the prompt; see the output log for details.")
      }
    } catch (e) {
      log("prompt call threw", e)
      this.failSend((e as Error).message || "Could not reach the opencode server.")
    }
    // No further UI action here — the SSE subscription owns assistant lifecycle.
  }

  /**
   * Unstick a turn that failed without producing SSE events. A send that
   * never reached opencode emits no session.idle, so two things would
   * otherwise hang: the webview's `busy` never clears (permanent "Working…"),
   * and — if `recordMainTaskStart` already ran — the popover Main row stays
   * "running" forever. Settle that row FIRST so the terminal-state guard
   * freezes its status against any later idle sweep, then post idle + toast.
   * `recordMainTaskFinish` is a no-op when no Main task was recorded (the
   * pre-dispatch failure sites: server-ensure / session-create), so this is
   * safe from every failure path. classifyTerminal keeps an "Aborted" outcome
   * quiet (no toast), mirroring onSessionError.
   */
  private failTurnUnstick(message: string, toastTitle: string) {
    const classified = classifyTerminal(message)
    void this.subagentDispatch.recordMainTaskFinish(classified.status, classified.error)
    this.post({ type: "sessionIdle" })
    if (classified.status === "error") {
      this.surfaceToast({ variant: "error", title: toastTitle, message })
    }
  }

  private failSend(message: string) {
    this.failTurnUnstick(message, "Send failed")
  }

  /**
   * Create the opencode session for a first send. Returns undefined after
   * routing the failure through failSend — a session that was never created
   * produces no SSE events, so the caller must stop instead of dispatching.
   */
  private async createSessionForSend(backend: Backend): Promise<string | undefined> {
    try {
      const created = await backend.client.session.create({ body: {} })
      if (created.error || !created.data) {
        log("session.create failed", created.error)
        this.failSend("opencode could not create a session; see the output log for details.")
        return undefined
      }
      return created.data.id
    } catch (e) {
      log("session.create threw", e)
      this.failSend((e as Error).message || "Could not reach the opencode server.")
      return undefined
    }
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
      this.failSend((e as Error).message || "Could not start the opencode server.")
      return
    }

    if (!this.sessionID) {
      const sessionID = await this.createSessionForSend(backend)
      if (!sessionID) return
      this.sessionID = sessionID
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
      if (res.error) {
        log("command failed", res.error)
        this.failSend("opencode rejected the command; see the output log for details.")
      }
    } catch (e) {
      log("command call threw", e)
      this.failSend((e as Error).message || "Could not reach the opencode server.")
    }
    // No further UI action here — the SSE subscription owns assistant lifecycle.
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
    await this.builtinRunners.run(command, backend)
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

  private async handleEdit(webviewID: string, text: string, mentions?: string[], attachments?: Attachment[], conversationMentions?: ConversationMention[]) {
    const target = this.messages.find((m) => m.id === webviewID && m.role === "user")
    if (!target) {
      log("editMessage: user message not found", webviewID)
      return
    }
    const trimmed = text.trim()
    if (!trimmed) return

    if (target.backendID && this.sessionID) {
      // A failed revert means the opencode session still holds the original
      // turns; truncating and resending anyway would silently diverge the
      // panel from the model's context, so the edit is abandoned instead.
      let revertFailed = false
      try {
        const backend = await this.servers.ensure()
        const res = await backend.client.session.revert({
          path: { id: this.sessionID },
          body: { messageID: target.backendID },
        })
        if (res.error) {
          log("session.revert failed", res.error)
          revertFailed = true
        }
      } catch (e) {
        log("session.revert threw", e)
        revertFailed = true
      }
      if (revertFailed) {
        void vscode.window.showErrorMessage("Failed to edit the message. The conversation is unchanged.")
        return
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
    }

    await this.handleSend(trimmed, mentions, attachments, conversationMentions)
  }

  private lastStreamReattachAt = 0

  /**
   * Best-effort re-subscribe after the SSE stream died. Throttled so a server
   * that crashes immediately on every boot can't drive a respawn loop —
   * outside the window the next user action re-attaches lazily instead.
   */
  private async reattachAfterStreamLoss() {
    if (!this.sessionID) return
    const now = Date.now()
    if (now - this.lastStreamReattachAt < ChatView.STREAM_REATTACH_MIN_MS) {
      log("[sse] re-attach throttled; will reconnect on next action")
      return
    }
    this.lastStreamReattachAt = now
    try {
      const backend = await this.servers.ensure()
      if (!this.sessionID || this.subscription) return
      await this.attachSubscription(backend, this.sessionID)
      log("[sse] re-attached after stream loss")
    } catch (e) {
      log("[sse] re-attach failed; will reconnect on next action", e)
    }
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
      onAssistantSummary: (mid) => {
        // Presentation-only flag; same ignore-while-aborting gate as the
        // other non-terminal events.
        if (this.aborting) return
        const webviewID = this.messageMap.get(mid) ?? this.ensureWebviewID(mid)
        this.post({ type: "assistantSummary", id: webviewID })
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
        this.queueDelta("textDelta", webviewID, delta)
      },
      onReasoningDelta: (mid, delta) => {
        if (this.aborting) return
        const webviewID = this.messageMap.get(mid) ?? this.ensureWebviewID(mid)
        this.queueDelta("reasoningDelta", webviewID, delta)
      },
      onTool: (mid, update) => {
        // While aborting, drop in-flight churn but let TERMINAL closures
        // through: a tool that finished (or errored) before the abort
        // propagated must not persist as "running" forever. Only for
        // messages we already know — never mint a new bubble mid-abort.
        const terminal = update.status === "completed" || update.status === "error"
        if (this.aborting && (!terminal || !this.messageMap.has(mid))) return
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
        // Patches describe disk mutations that ALREADY happened — dropping
        // them while aborting just hides real changes from the Review panel.
        if (this.aborting && !this.messageMap.has(mid)) return
        const webviewID = this.messageMap.get(mid) ?? this.ensureWebviewID(mid)
        this.post({
          type: "patch",
          id: webviewID,
          files: files.map((f) => relativeToCwd(backend.directory, f)),
          diff,
        })
      },
      onPermissionNeeded: (perm) => {
        // Same ignore-while-aborting gate as the other non-terminal events:
        // a permission raised mid-Stop targets a session being torn down,
        // and no resolution event exists that would ever clear the dialog.
        if (this.aborting) return
        this.activePermissions.set(perm.id, perm)
        this.syncAgentWaitState()
        this.post({
          type: "permission",
          id: perm.id,
          title: perm.title,
          pattern: perm.pattern,
        })
      },
      onQuestionAsked: (q) => {
        if (this.aborting) return
        this.activeQuestions.set(q.id, q)
        this.syncAgentWaitState()
        this.post({
          type: "question",
          id: q.id,
          questions: q.questions,
        })
      },
      onQuestionResolved: (id) => {
        this.activeQuestions.delete(id)
        this.syncAgentWaitState()
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
        this.settleSessionIdle()
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
      onStreamClosed: (reason) => {
        // No further events will arrive on this subscription. Drop it so the
        // `!this.subscription` re-attach checks work again (a dead-but-truthy
        // subscription used to block reconnection forever), unstick the
        // composer, and try one throttled re-attach — `ensure()` respawns the
        // server if the process died.
        if (this.subscription !== subscription) return
        log(`[sse] stream closed (${reason}); scheduling re-attach`)
        this.subscription = undefined
        this.aborting = false
        this.continuationState.finishPending()
        this.post({ type: "sessionIdle" })
        void this.reattachAfterStreamLoss()
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
      return
    }
    this.post({
      type: "patch",
      id: parentWebviewID,
      files: event.files.map((f) => relativeToCwd(cwd, f)),
      diff: event.diff,
      actor,
    })
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
    if (!isTextReviewPathName(change.path)) {
      vscode.window.showWarningMessage(`OpenCode Panel: ${change.path} cannot be reviewed as text.`)
      return
    }
    try {
      const root = this.backendDirectory()
      const doc = await openFileDocument(change.path, root)
      // Skips the re-show when this file is already the active editor — common
      // when the user just clicked a different row and the editor already moved
      // there. `revealDocument` owns that guard; the Undo path needs the same
      // one, and having each side spell it out is how they drifted apart.
      await revealDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false })
      // Hunk-state reconciliation (purging missing-file hunks) is independent
      // of where the editor is pointed — queue it so the editor swap never
      // waits on fs.stat I/O.
      this.queueReviewHunkSync()
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
    // No explicit sync here: applied > 0 guarantees at least one
    // reviewHunkState post above (the all-reviewed case returned early inside
    // reviewAllForPath), and each of those already queued the debounced sync.
    if (result.applied === 0) {
      log("reviewAllInChange: no hunks applied", { source, path: requestedPath, action, conflicts: result.conflicts })
    }
  }

  private backendDirectory(): string | undefined {
    return this.servers.currentWorkspace()?.fsPath
  }

  private reviewSyncTimer?: ReturnType<typeof setTimeout>
  private static readonly REVIEW_SYNC_DEBOUNCE_MS = 100

  /**
   * Debounced entry to syncReviewHunks. Review-relevant events arrive in
   * bursts — tool closures during a streaming turn, one reviewHunkState post
   * per hunk from Keep/Undo-all — and each pass costs a full extract +
   * aggregate plus an fs.stat per changed path, so bursts must collapse into
   * one pass. Same first-call-arms idiom as queueDelta: events landing inside
   * the window ride the pending timer.
   */
  private queueReviewHunkSync() {
    this.reviewSyncTimer ??= setTimeout(() => {
      this.reviewSyncTimer = undefined
      this.syncReviewHunks().catch((e) => log("review hunk sync failed", e))
    }, ChatView.REVIEW_SYNC_DEBOUNCE_MS)
  }

  private async syncReviewHunks() {
    // All editor-side review UI (line highlights, ghost-text deletions,
    // unlocatable banner) was removed — review actions live exclusively in
    // the Review Card now. This sync only purges hunks for files that have
    // been deleted on disk so they don't linger in the panel.
    const changes = reviewChanges(this.messages).filter((change) => isTextReviewPathName(change.path))
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
