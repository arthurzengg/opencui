import type { ChatBlock, ChatMessage, ConversationMention } from "./protocol"

/**
 * One recallable prompt. Carries the mention bindings alongside the text
 * because the composer only paints an `@path` as a chip — and only re-sends it
 * as file context — when the label is registered in its known-mention refs.
 * Recalling bare text would render the chips as plain prose and silently drop
 * the attached files.
 */
export type PromptHistoryEntry = {
  text: string
  mentions?: string[]
  conversationMentions?: ConversationMention[]
}

/**
 * Recallable prompts for the active conversation, oldest first. Derived from
 * the rendered user messages rather than tracked as separate state: those
 * already survive a window reload and already reset on conversation switch, so
 * deriving gets both properties for free and cannot drift from what the user
 * sees in the transcript.
 */
export function promptHistory(messages: ChatMessage[]): PromptHistoryEntry[] {
  const entries: PromptHistoryEntry[] = []
  for (const message of messages) {
    if (message.role !== "user") continue
    const text = message.blocks
      .filter((b): b is Extract<ChatBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n\n")
    if (!text.trim()) continue
    // Collapse an immediately repeated prompt (a resend after an error, or an
    // edit re-submitted unchanged) so Up doesn't stall on the same text twice.
    if (entries.at(-1)?.text === text) continue
    entries.push({
      text,
      mentions: message.mentions,
      conversationMentions: message.conversationMentions,
    })
  }
  return entries
}

/**
 * Whether Up at `caret` should recall history instead of moving the caret.
 * Arrow keys belong to the textarea as long as there is another line to move
 * to; history only takes over at the outer edge — the rule shells and
 * multi-line REPLs use. Logical lines, not visual: a soft-wrapped long line
 * counts as one, so wrapping width never changes which key does what.
 */
export function caretAtFirstLine(text: string, caret: number): boolean {
  return !text.slice(0, caret).includes("\n")
}

/** Mirror of {@link caretAtFirstLine} for Down. */
export function caretAtLastLine(text: string, caret: number): boolean {
  return !text.slice(caret).includes("\n")
}
