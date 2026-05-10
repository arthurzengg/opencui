import { describe, it, expect } from "vitest"
import { groupTurns } from "../../webview/src/App"
import type { Message } from "../../webview/src/hooks/useChatState"

function user(id: string, text = ""): Message {
  return { id, role: "user", blocks: [{ type: "text", text }] }
}

function assistant(id: string, text = ""): Message {
  return { id, role: "assistant", blocks: [{ type: "text", text }] }
}

describe("groupTurns", () => {
  it("returns no turns for an empty conversation", () => {
    expect(groupTurns([])).toEqual([])
  })

  it("wraps a single user message into one turn with no assistants", () => {
    const out = groupTurns([user("u1")])
    expect(out).toHaveLength(1)
    expect(out[0]?.user?.id).toBe("u1")
    expect(out[0]?.assistants).toEqual([])
    expect(out[0]?.key).toBe("u1")
  })

  it("groups user + following assistant messages into one turn", () => {
    const out = groupTurns([user("u1"), assistant("a1"), assistant("a2")])
    expect(out).toHaveLength(1)
    expect(out[0]?.user?.id).toBe("u1")
    expect(out[0]?.assistants.map((m) => m.id)).toEqual(["a1", "a2"])
  })

  it("starts a new turn on each user message", () => {
    const out = groupTurns([
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
      user("u3"),
    ])
    expect(out).toHaveLength(3)
    expect(out[0]?.user?.id).toBe("u1")
    expect(out[0]?.assistants.map((m) => m.id)).toEqual(["a1"])
    expect(out[1]?.user?.id).toBe("u2")
    expect(out[1]?.assistants.map((m) => m.id)).toEqual(["a2"])
    expect(out[2]?.user?.id).toBe("u3")
    expect(out[2]?.assistants).toEqual([])
  })

  it("supports a leading assistant-only turn (no user)", () => {
    const out = groupTurns([assistant("a1"), assistant("a2"), user("u1"), assistant("a3")])
    expect(out).toHaveLength(2)
    expect(out[0]?.user).toBeUndefined()
    expect(out[0]?.assistants.map((m) => m.id)).toEqual(["a1", "a2"])
    expect(out[0]?.key).toBe("a1")
    expect(out[1]?.user?.id).toBe("u1")
    expect(out[1]?.assistants.map((m) => m.id)).toEqual(["a3"])
  })

  it("uses the user message id as the turn key when present", () => {
    const out = groupTurns([user("u1"), assistant("a1")])
    expect(out[0]?.key).toBe("u1")
  })
})
