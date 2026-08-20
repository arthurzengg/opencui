import * as vscode from "vscode"
import type { ChatMessage, ConversationSummary, ReviewHunkState } from "../protocol"
import {
  ACTIVE_CONVERSATION_KEY,
  CONVERSATIONS_KEY,
  attachmentStorageIDs,
  normalizeConversationMentions,
  stripAttachmentDataForPersist,
  type SavedConversation,
} from "./conversation-store"
import { dataUrlToBytes } from "./attachment-store"

/**
 * The slice of ChatView state that gets stamped onto the active
 * conversation every time the chat mutates. ChatView still owns the
 * live `messages` / `reviewHunks` / `sessionID` fields (deeply woven
 * through the reducer + stream handlers); the manager just persists
 * snapshots of them.
 */
export type ActiveSnapshot = {
  sessionID?: string
  messages: ChatMessage[]
  reviewHunks: Record<string, ReviewHunkState>
}

/** Debounce window for the streaming hot path's disk writes. */
const PERSIST_DEBOUNCE_MS = 300

/**
 * Workspace-state-backed list of saved conversations. Owns the
 * conversation array, the active-conversation-id pointer, and the
 * persistence layer. ChatView delegates CRUD / persistence here; the
 * orchestration around a conversation transition (session teardown,
 * subscription abort, task-store reset) stays on ChatView because it
 * spans multiple subsystems.
 */
export class ConversationManager {
  private conversations: SavedConversation[]
  private activeID: string
  private pendingPersist?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(private context: vscode.ExtensionContext) {
    this.conversations = context.workspaceState.get<SavedConversation[]>(CONVERSATIONS_KEY) ?? []
    this.activeID = context.workspaceState.get<string>(ACTIVE_CONVERSATION_KEY) ?? ""
    if (!this.conversations.length) this.add("New conversation")
    if (!this.conversations.some((c) => c.id === this.activeID)) {
      this.activeID = this.conversations[0]!.id
    }
  }

  getActiveID(): string {
    return this.activeID
  }

  setActiveID(id: string) {
    this.activeID = id
  }

  /**
   * Prepend a new conversation with a fresh id + timestamp.
   */
  add(title: string): SavedConversation {
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

  /**
   * Whether a conversation is an untouched "New conversation": still the
   * default title with no messages. Such a chat is a reuse candidate for the
   * New-chat action.
   */
  private isUntouchedNew(c: SavedConversation): boolean {
    return c.title === "New conversation" && c.messages.length === 0
  }

  /**
   * Backing for the New-chat action ("+" / "+ New chat"). If an untouched
   * "New conversation" already exists anywhere in the list — not just as the
   * active chat — reuse it: bump its created/updated time and move it to the
   * front (`reused: true`) instead of stacking a second identical empty
   * chat. The active conversation is preferred when several qualify (legacy
   * duplicates). Otherwise add a fresh one (`reused: false`).
   */
  addOrReuseEmpty(title: string): { conversation: SavedConversation; reused: boolean } {
    const active = this.conversations.find((c) => c.id === this.activeID)
    const candidate =
      active && this.isUntouchedNew(active)
        ? active
        : this.conversations.find((c) => this.isUntouchedNew(c))
    if (candidate) {
      const now = Date.now()
      const refreshed: SavedConversation = { ...candidate, createdAt: now, updatedAt: now }
      this.conversations = [refreshed, ...this.conversations.filter((c) => c.id !== refreshed.id)]
      return { conversation: refreshed, reused: true }
    }
    return { conversation: this.add(title), reused: false }
  }

  getMessages(id: string): ChatMessage[] | undefined {
    const conv = this.conversations.find((c) => c.id === id)
    if (!conv) return undefined
    return conv.messages.map((m) => normalizeConversationMentions({ ...m, pending: false }))
  }

  getTitle(id: string): string | undefined {
    return this.conversations.find((c) => c.id === id)?.title
  }

  /** Backend session IDs already bound to a saved conversation. */
  boundSessionIDs(): Set<string> {
    const ids = new Set<string>()
    for (const c of this.conversations) if (c.sessionID) ids.add(c.sessionID)
    return ids
  }

  /** The saved conversation bound to a backend session, if any. */
  findBySessionID(sessionID: string): string | undefined {
    return this.conversations.find((c) => c.sessionID === sessionID)?.id
  }

  summaries(): ConversationSummary[] {
    return this.conversations
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * Resolve the active SavedConversation, creating a fresh one on the
   * spot if the active id points at nothing (defensive — should only
   * happen on first launch or after corruption).
   */
  active(): SavedConversation {
    const conversation = this.conversations.find((c) => c.id === this.activeID)
    if (conversation) return conversation
    const created = this.add("New conversation")
    this.activeID = created.id
    return created
  }

  /**
   * Hydrate the persisted snapshot for the active conversation. Used at
   * startup and after `setActiveID` to repopulate ChatView's in-memory
   * state. Messages have `pending: false` re-stamped because we never
   * persist a half-streamed turn as still-pending.
   */
  loadActiveSnapshot(): ActiveSnapshot {
    const c = this.active()
    return {
      sessionID: c.sessionID,
      messages: c.messages.map((m) => normalizeConversationMentions({ ...m, pending: false })),
      reviewHunks: c.reviewHunks ?? {},
    }
  }

  rename(id: string, title: string): void {
    const nextTitle = title.replace(/\s+/g, " ").trim().slice(0, 80)
    if (!nextTitle) return
    this.conversations = this.conversations.map((c) =>
      c.id === id ? { ...c, title: nextTitle, updatedAt: Date.now() } : c,
    )
  }

  /**
   * Remove a conversation from the list. If the list would become empty
   * we add a fresh "New conversation" so the picker always has at least
   * one entry. Does NOT trigger any session/subscription teardown; the
   * caller is responsible for that when the removed id was active.
   */
  remove(id: string): void {
    this.conversations = this.conversations.filter((c) => c.id !== id)
    if (!this.conversations.length) this.add("New conversation")
  }

  updateActive(fn: (c: SavedConversation) => SavedConversation): void {
    const next = fn(this.active())
    this.conversations = [next, ...this.conversations.filter((c) => c.id !== next.id)]
  }

  /**
   * Convenience wrapper for the common "save current chat state" case
   * called from many sites in ChatView.
   */
  saveActiveSnapshot(snapshot: ActiveSnapshot): void {
    this.updateActive((c) => ({
      ...c,
      sessionID: snapshot.sessionID,
      messages: snapshot.messages,
      reviewHunks: snapshot.reviewHunks,
      updatedAt: Date.now(),
    }))
  }

  /**
   * If the active conversation still has the default title and is on
   * its first turn, derive a new title from the user's prompt. Returns
   * true if the title was actually updated so the caller knows to
   * re-post the conversations list to the webview.
   */
  updateTitleFromPrompt(text: string, messageCount: number): boolean {
    const conversation = this.active()
    if (conversation.title !== "New conversation" || messageCount > 1) return false
    const title = text.replace(/\s+/g, " ").trim().slice(0, 64) || "New conversation"
    this.updateActive((c) => ({ ...c, title }))
    return true
  }

  async persist(): Promise<void> {
    // Store-backed attachments persist as a storageID reference only; the
    // inline base64 stays in memory for previews but never reaches
    // workspaceState (it's what made streaming persists cost ~100 ms+).
    await this.context.workspaceState.update(
      CONVERSATIONS_KEY,
      stripAttachmentDataForPersist(this.conversations),
    )
    await this.context.workspaceState.update(ACTIVE_CONVERSATION_KEY, this.activeID)
  }

  /**
   * One-shot legacy migration: move inline base64 attachments (persisted
   * before the attachment store existed) onto disk via `save`, stamping the
   * resulting storageID onto each block. The dataUrl is kept in memory —
   * `persist()` strips it now that a storageID exists. Blocks whose save
   * fails are left untouched and keep working the legacy way.
   */
  async migrateAttachments(save: (bytes: Uint8Array) => Promise<string | undefined>): Promise<boolean> {
    let changed = false
    const next: SavedConversation[] = []
    for (const conversation of this.conversations) {
      let conversationChanged = false
      const messages: SavedConversation["messages"] = []
      for (const message of conversation.messages) {
        let messageChanged = false
        const blocks = [...message.blocks]
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i]!
          if (block.type !== "attachment" || block.storageID || !block.dataUrl) continue
          const bytes = dataUrlToBytes(block.dataUrl)
          if (!bytes) continue
          const storageID = await save(bytes)
          if (!storageID) continue
          blocks[i] = { ...block, storageID }
          messageChanged = true
        }
        messages.push(messageChanged ? { ...message, blocks } : message)
        if (messageChanged) conversationChanged = true
      }
      next.push(conversationChanged ? { ...conversation, messages } : conversation)
      if (conversationChanged) changed = true
    }
    if (changed) this.conversations = next
    return changed
  }

  /** Attachment-store references held by one conversation (delete-time GC). */
  storageIDs(id: string): string[] {
    const conversation = this.conversations.find((c) => c.id === id)
    return conversation ? attachmentStorageIDs(conversation.messages) : []
  }

  /** Attachment-store references held by every remaining conversation. */
  allStorageIDs(): Set<string> {
    const ids = new Set<string>()
    for (const conversation of this.conversations) {
      for (const id of attachmentStorageIDs(conversation.messages)) ids.add(id)
    }
    return ids
  }

  /**
   * Debounced disk write for the streaming hot path. `saveActiveSnapshot`
   * already updated the in-memory state synchronously, so this only
   * coalesces the expensive workspaceState serialization. Non-resetting
   * trailing edge: an already-pending timer is left to fire rather than
   * pushed back, so inter-write latency stays capped at PERSIST_DEBOUNCE_MS
   * even through an unbroken token stream — and `persist()` always writes
   * the latest `this.conversations`, so a late-firing timer is never stale.
   */
  schedulePersist(): void {
    if (this.disposed || this.pendingPersist) return
    this.pendingPersist = setTimeout(() => {
      this.pendingPersist = undefined
      if (this.disposed) return
      void this.persist()
    }, PERSIST_DEBOUNCE_MS)
  }

  /**
   * Cancel any pending debounced write and persist the latest state now.
   * Called at every conversation boundary, at turn end, and on shutdown so
   * a debounced tail is never lost.
   */
  async flushPersist(): Promise<void> {
    this.clearPending()
    await this.persist()
  }

  private clearPending(): void {
    if (this.pendingPersist) {
      clearTimeout(this.pendingPersist)
      this.pendingPersist = undefined
    }
  }

  /**
   * Stop accepting debounced writes. Guards against a stray timer firing
   * after the owning ChatView (and its context) is torn down. Callers that
   * need the tail on disk must `flushPersist()` first.
   */
  dispose(): void {
    this.disposed = true
    this.clearPending()
  }
}
