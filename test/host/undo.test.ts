import { describe, it, expect } from "vitest"
import { lastUserTurnIndex, redoAction, userMessageText } from "../../src/chat/undo"
import type { ChatMessage } from "../../src/protocol"

function user(id: string, text: string, backendID?: string): ChatMessage {
  return { id, role: "user", blocks: [{ type: "text", text }], backendID }
}
function assistant(id: string, backendID?: string): ChatMessage {
  return { id, role: "assistant", blocks: [], backendID }
}

describe("lastUserTurnIndex", () => {
  it("returns -1 for an empty transcript", () => {
    expect(lastUserTurnIndex([])).toBe(-1)
  })

  it("returns -1 when no user message has a backendID yet", () => {
    expect(lastUserTurnIndex([user("u1", "hi")])).toBe(-1)
  })

  it("finds the last settled user turn, skipping the trailing assistant", () => {
    const msgs = [user("u1", "a", "b1"), assistant("a1", "ba1"), user("u2", "b", "b2"), assistant("a2", "ba2")]
    expect(lastUserTurnIndex(msgs)).toBe(2)
  })

  it("ignores a trailing user message that has no backendID (still streaming in)", () => {
    const msgs = [user("u1", "a", "b1"), assistant("a1", "ba1"), user("u2", "pending")]
    expect(lastUserTurnIndex(msgs)).toBe(0)
  })
})

describe("redoAction", () => {
  it("unreverts when no tail remains on the stack", () => {
    expect(redoAction(undefined)).toEqual({ kind: "unrevert" })
  })

  it("reverts to the next tail's first message id", () => {
    const tail = [user("u3", "c", "b3"), assistant("a3", "ba3")]
    expect(redoAction(tail)).toEqual({ kind: "revert", messageID: "b3" })
  })

  it("unreverts when the next tail's first message lacks a backendID", () => {
    expect(redoAction([user("u3", "c")])).toEqual({ kind: "unrevert" })
  })
})

describe("userMessageText", () => {
  it("reads the prompt from the first text block", () => {
    expect(userMessageText(user("u1", "hello world", "b1"))).toBe("hello world")
  })

  it("returns an empty string when there is no text block", () => {
    expect(userMessageText({ id: "x", role: "user", blocks: [] })).toBe("")
  })
})
