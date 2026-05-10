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
 */
export function migrateConversationsToWorkspace(context: vscode.ExtensionContext) {
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
