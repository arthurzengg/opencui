import * as vscode from "vscode"
import type { ChatMessage, ConversationMention, ConversationSummary, ReviewHunkState } from "../protocol"

export const CONVERSATIONS_KEY = "opencui.conversations"
export const ACTIVE_CONVERSATION_KEY = "opencui.activeConversation"
export const MIGRATED_TO_WORKSPACE_KEY = "opencui.migratedToWorkspaceState"

export type SavedConversation = ConversationSummary & {
  createdAt: number
  sessionID?: string
  messages: ChatMessage[]
  reviewHunks?: Record<string, ReviewHunkState>
}

/**
 * Messages persisted before conversation mentions carried their chip label
 * stored a bare conversation-id array; the label was re-derived from the text
 * by position at edit time — the exact inference the pair shape removes.
 * Normalize a legacy array by zipping ids with the `@chat:` tokens in text
 * order (the same pairing the old edit flow computed), so old data behaves as
 * it always did while everything written from now on carries exact pairs.
 * Ids beyond the labels found in the text are dropped: with no label they
 * could never match a chip, so they contributed nothing before either.
 */
export function normalizeConversationMentions(message: ChatMessage): ChatMessage {
  const raw = message.conversationMentions as unknown
  if (!Array.isArray(raw) || raw.length === 0) return message
  if (raw.every(isConversationMention)) return message
  const ids = raw.filter((item): item is string => typeof item === "string")
  const textBlock = message.blocks.find((b) => b.type === "text")
  const text = textBlock && textBlock.type === "text" ? textBlock.text : ""
  const labels = Array.from(text.matchAll(/@chat:\S+/g), (match) => match[0].slice(1))
  const pairs: ConversationMention[] = []
  for (const [index, id] of ids.entries()) {
    const label = labels[index]
    if (label) pairs.push({ label, id })
  }
  return { ...message, conversationMentions: pairs.length ? pairs : undefined }
}

function isConversationMention(value: unknown): value is ConversationMention {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { label?: unknown }).label === "string" &&
    typeof (value as { id?: unknown }).id === "string"
  )
}

/**
 * One-shot copy of conversation data from the legacy global storage into the
 * current workspace's state. Runs once per workspace; subsequent activations
 * see the migrated data already in workspaceState and skip the copy.
 *
 * Existing global storage keys are cleared after the first successful migration
 * so a different workspace doesn't see the same conversations duplicated.
 *
 * Writes are awaited sequentially: if any of the data writes reject (e.g. the
 * workspace storage layer is unavailable), the "migration done" flag is NOT
 * set, so the next activation retries the migration instead of silently
 * declaring it complete with no data persisted.
 */
export async function migrateConversationsToWorkspace(context: vscode.ExtensionContext) {
  if (context.workspaceState.get<boolean>(MIGRATED_TO_WORKSPACE_KEY, false)) return
  const legacy = context.globalState.get<SavedConversation[]>(CONVERSATIONS_KEY)
  if (legacy && legacy.length) {
    const legacyActive = context.globalState.get<string>(ACTIVE_CONVERSATION_KEY)
    // Issue BOTH workspaceState writes before the first await: the caller
    // constructs ConversationManager (which reads both keys synchronously)
    // without awaiting this function, and only the synchronous cache write
    // of an update that has already STARTED is visible to it. Awaiting the
    // conversations write before starting the active-pointer write meant the
    // manager fell back to conversations[0] and persisted that over the
    // legacy pointer — with globalState already cleared, unrecoverably.
    const writes = [context.workspaceState.update(CONVERSATIONS_KEY, legacy)]
    if (legacyActive) writes.push(context.workspaceState.update(ACTIVE_CONVERSATION_KEY, legacyActive))
    await Promise.all(writes)
    await context.globalState.update(CONVERSATIONS_KEY, undefined)
    await context.globalState.update(ACTIVE_CONVERSATION_KEY, undefined)
  }
  await context.workspaceState.update(MIGRATED_TO_WORKSPACE_KEY, true)
}
