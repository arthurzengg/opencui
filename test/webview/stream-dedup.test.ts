import { describe, it, expect } from "vitest"
import { reducer, initialChatState } from "../../webview/src/hooks/useChatState"

describe("reducer — re-announced assistant message", () => {
  it("assistantStart for an id already in the transcript is a no-op by reference", () => {
    // An SSE re-attach mid-turn (or trailing bookkeeping after a reload) can
    // announce a message the transcript already holds; a second row with the
    // same id duplicated the bubble and every later delta (#585).
    let state = reducer(initialChatState, { type: "assistantStart", id: "a_1" })
    state = reducer(state, { type: "textDelta", id: "a_1", delta: "Hi" })
    state = reducer(state, { type: "sessionIdle" })

    const again = reducer(state, { type: "assistantStart", id: "a_1" })

    expect(again).toBe(state)
    expect(again.messages).toHaveLength(1)
  })

  it("a delta after the re-announcement lands in the single existing row", () => {
    let state = reducer(initialChatState, { type: "assistantStart", id: "a_1" })
    state = reducer(state, { type: "textDelta", id: "a_1", delta: "Hi" })
    state = reducer(state, { type: "assistantStart", id: "a_1" })
    state = reducer(state, { type: "textDelta", id: "a_1", delta: " there" })

    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]!.blocks).toEqual([{ type: "text", text: "Hi there" }])
  })
})
