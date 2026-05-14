import { describe, it, expect } from "vitest"
import { reducer, initialChatState } from "../../webview/src/hooks/useChatState"

function withAssistant(id: string, opts: { pending?: boolean } = {}) {
  return reducer(
    { ...initialChatState, busy: opts.pending ?? false },
    { type: "assistantStart", id },
  )
}

describe("reducer — messageRemoved", () => {
  it("drops the message with the matching id", () => {
    const before = withAssistant("a1", { pending: true })
    expect(before.messages.find((m) => m.id === "a1")).toBeTruthy()
    const after = reducer(before, { type: "messageRemoved", id: "a1" })
    expect(after.messages.find((m) => m.id === "a1")).toBeUndefined()
  })

  it("clears busy when the removed message was the only pending one", () => {
    const before = withAssistant("a1", { pending: true })
    expect(before.busy).toBe(true)
    const after = reducer(before, { type: "messageRemoved", id: "a1" })
    expect(after.busy).toBe(false)
  })

  it("keeps busy when another pending assistant survives the removal", () => {
    const one = withAssistant("a1", { pending: true })
    const two = reducer(one, { type: "assistantStart", id: "a2" })
    expect(two.messages).toHaveLength(2)
    const after = reducer(two, { type: "messageRemoved", id: "a1" })
    expect(after.busy).toBe(true)
    expect(after.messages.find((m) => m.id === "a2")).toBeTruthy()
  })

  it("is a no-op when the id is not in the message list", () => {
    const before = withAssistant("a1", { pending: true })
    const after = reducer(before, { type: "messageRemoved", id: "missing" })
    expect(after).toBe(before)
  })
})
