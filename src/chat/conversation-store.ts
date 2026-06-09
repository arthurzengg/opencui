import * as vscode from "vscode"
import type { ChatMessage, ConversationSummary, ReviewHunkState } from "../protocol"

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
