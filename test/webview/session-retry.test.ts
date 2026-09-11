import { describe, it, expect } from "vitest"
import { reducer, initialChatState } from "../../webview/src/hooks/useChatState"

const retry = { attempt: 2, message: "Provider is overloaded", next: 1_800_000_000_000 }

function pendingAssistant(id = "a1") {
  return reducer({ ...initialChatState, busy: true }, { type: "assistantStart", id })
}

describe("reducer sessionRetry (#611)", () => {
  it("stores the retry and clears it when the host sends none", () => {
    const set = reducer(pendingAssistant(), { type: "sessionRetry", retry })
    expect(set.retry).toEqual(retry)
    expect(reducer(set, { type: "sessionRetry" }).retry).toBeUndefined()
  })

  it("sessionIdle and aborted clear it", () => {
    const set = reducer(pendingAssistant(), { type: "sessionRetry", retry })
    expect(reducer(set, { type: "sessionIdle" }).retry).toBeUndefined()
    expect(reducer(set, { type: "aborted" }).retry).toBeUndefined()
  })

  it("a retry arriving mid-Stop is dropped", () => {
    const aborted = reducer(pendingAssistant(), { type: "aborted" })
    expect(reducer(aborted, { type: "sessionRetry", retry })).toBe(aborted)
  })

  it("restore does not carry a retry into another conversation", () => {
    const set = reducer(pendingAssistant(), { type: "sessionRetry", retry })
    const restored = reducer(set, { type: "restore", conversationID: "c2", messages: [] })
    expect(restored.retry).toBeUndefined()
  })
})
