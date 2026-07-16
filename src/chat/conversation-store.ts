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
 * Persistence-boundary strip: attachment blocks whose bytes live in the
 * attachment store (they carry a `storageID`) lose their inline base64
 * `dataUrl` copy before hitting workspaceState. In-memory and wire
 * representations keep the dataUrl for previews; this only shapes what the
 * 300 ms persist loop serializes. Legacy blocks without a storageID are left
 * untouched — stripping them would lose the only copy of the bytes.
 */
export function stripAttachmentDataForPersist(conversations: SavedConversation[]): SavedConversation[] {
  const stripBlock = (b: ChatMessage["blocks"][number]) =>
    b.type === "attachment" && b.storageID && b.dataUrl ? { ...b, dataUrl: undefined } : b
  const needsStrip = (m: ChatMessage) =>
    m.blocks.some((b) => b.type === "attachment" && b.storageID && b.dataUrl)
  return conversations.map((c) => {
    if (!c.messages.some(needsStrip)) return c
    return {
      ...c,
      messages: c.messages.map((m) => (needsStrip(m) ? { ...m, blocks: m.blocks.map(stripBlock) } : m)),
    }
  })
}

/** All attachment-store references inside a message list (GC bookkeeping). */
export function attachmentStorageIDs(messages: ChatMessage[]): string[] {
  const ids: string[] = []
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === "attachment" && b.storageID) ids.push(b.storageID)
    }
  }
  return ids
}

/**
 * Copy freshly-minted storageIDs from a migrated copy of the active
 * conversation onto the live message array, matching by message id + block
 * position. Keeps ChatView's in-memory state in step with the manager after
 * a legacy-attachment migration WITHOUT re-hydrating (which would clobber
 * in-flight message state) and without writing the bytes a second time.
 */
export function adoptStorageIDs(live: ChatMessage[], migrated: ChatMessage[]): ChatMessage[] {
  const byID = new Map(migrated.map((m) => [m.id, m]))
  return live.map((m) => {
    const source = byID.get(m.id)
    if (!source) return m
    let changed = false
    const blocks = m.blocks.map((b, i) => {
      const s = source.blocks[i]
      if (
        b.type === "attachment" && !b.storageID &&
        s?.type === "attachment" && s.storageID
      ) {
        changed = true
        return { ...b, storageID: s.storageID }
      }
      return b
    })
    return changed ? { ...m, blocks } : m
  })
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
