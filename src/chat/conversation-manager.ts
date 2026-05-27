import * as vscode from "vscode"
import type { ChatMessage, ConversationSummary, ReviewHunkState } from "../protocol"
import {
  ACTIVE_CONVERSATION_KEY,
  CONVERSATIONS_KEY,
  type SavedConversation,
} from "./conversation-store"

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

  getMessages(id: string): ChatMessage[] | undefined {
    const conv = this.conversations.find((c) => c.id === id)
    if (!conv) return undefined
    return conv.messages.map((m) => ({ ...m, pending: false }))
  }

  getTitle(id: string): string | undefined {
    return this.conversations.find((c) => c.id === id)?.title
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
      messages: c.messages.map((m) => ({ ...m, pending: false })),
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
    await this.context.workspaceState.update(CONVERSATIONS_KEY, this.conversations)
    await this.context.workspaceState.update(ACTIVE_CONVERSATION_KEY, this.activeID)
  }
}
