import { describe, it, expect } from "vitest"
import {
  ACTIVE_CONVERSATION_KEY,
  CONVERSATIONS_KEY,
  normalizeConversationMentions,
  type SavedConversation,
} from "../../src/chat/conversation-store"
import { ConversationManager } from "../../src/chat/conversation-manager"
import type { ChatMessage, ConversationMention } from "../../src/protocol"

function userMessage(text: string, conversationMentions?: unknown): ChatMessage {
  return {
    id: "u1",
    role: "user",
    blocks: [{ type: "text", text }],
    conversationMentions: conversationMentions as ConversationMention[] | undefined,
  }
}

describe("normalizeConversationMentions", () => {
  it("zips legacy id arrays with @chat: labels in text order", () => {
    const out = normalizeConversationMentions(
      userMessage("@chat:A @chat:B compare these", ["a", "b"]),
    )
    expect(out.conversationMentions).toEqual([
      { label: "chat:A", id: "a" },
      { label: "chat:B", id: "b" },
    ])
  })

  it("returns pair-shaped mentions and mention-less messages unchanged", () => {
    const pairs = [{ label: "chat:A", id: "a" }]
    const withPairs = userMessage("@chat:A hi", pairs)
    expect(normalizeConversationMentions(withPairs)).toBe(withPairs)
    const withoutMentions = userMessage("plain")
    expect(normalizeConversationMentions(withoutMentions)).toBe(withoutMentions)
  })

  it("drops legacy ids beyond the labels found in the text", () => {
    const out = normalizeConversationMentions(userMessage("@chat:A only", ["a", "b"]))
    expect(out.conversationMentions).toEqual([{ label: "chat:A", id: "a" }])
  })

  it("clears legacy mentions when the text has no chat tokens", () => {
    const out = normalizeConversationMentions(userMessage("no chips here", ["a"]))
    expect(out.conversationMentions).toBeUndefined()
  })
})

describe("ConversationManager legacy mention normalization", () => {
  function managerWith(messages: ChatMessage[]): ConversationManager {
    const now = Date.now()
    const conversations: SavedConversation[] = [
      { id: "c1", title: "Chat", createdAt: now, updatedAt: now, messages, reviewHunks: {} },
    ]
    const store = new Map<string, unknown>([
      [CONVERSATIONS_KEY, conversations],
      [ACTIVE_CONVERSATION_KEY, "c1"],
    ])
    const workspaceState = {
      get: <T,>(key: string, def?: T): T => (store.has(key) ? (store.get(key) as T) : (def as T)),
      update: (key: string, value: unknown) => {
        store.set(key, value)
        return Promise.resolve()
      },
      keys: () => [...store.keys()],
    }
    return new ConversationManager({ workspaceState } as never)
  }

  it("normalizes persisted legacy arrays on both read paths", () => {
    const manager = managerWith([userMessage("@chat:Old revisit", ["old-id"])])
    const expected = [{ label: "chat:Old", id: "old-id" }]
    expect(manager.loadActiveSnapshot().messages[0]!.conversationMentions).toEqual(expected)
    expect(manager.getMessages("c1")![0]!.conversationMentions).toEqual(expected)
  })
})
