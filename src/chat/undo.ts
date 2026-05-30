/**
 * Pure helpers for the `/undo` and `/redo` built-ins. Kept free of `vscode` and
 * the SDK so they unit-test in the node project (mirrors `src/chat/paths.ts`).
 */
import type { ChatMessage } from "../protocol"

/**
 * Index of the last settled user turn — a user message that already carries a
 * `backendID`. That is the message `/undo` reverts the session to. Returns -1
 * when there is nothing to undo. A `backendID` is required because the revert
 * call targets the opencode message id, which a user bubble only has once the
 * SSE has associated it.
 */
export function lastUserTurnIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === "user" && m.backendID) return i
  }
  return -1
}

/**
 * The server call `/redo` makes after popping the tail it restores. opencode
 * moves the revert pointer to the first message of the next still-reverted tail,
 * or clears it (`unrevert`) when nothing remains reverted. `nextTail` is the new
 * top of the redo stack (i.e. after the pop), or undefined when the stack is empty.
 */
export function redoAction(
  nextTail: ChatMessage[] | undefined,
): { kind: "revert"; messageID: string } | { kind: "unrevert" } {
  const messageID = nextTail?.[0]?.backendID
  if (messageID) return { kind: "revert", messageID }
  return { kind: "unrevert" }
}

/** The plain prompt text of a user message, read from its first text block. */
export function userMessageText(message: ChatMessage): string {
  const block = message.blocks.find((b) => b.type === "text")
  return block && block.type === "text" ? block.text : ""
}
