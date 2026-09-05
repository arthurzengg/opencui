import { describe, it, expect } from "vitest"
import { reducer, initialChatState, type ChatState } from "../../webview/src/hooks/useChatState"
import type { ToolUpdate } from "../../webview/src/protocol"

// The Review panel keys its diff extraction on `reviewRevision` instead of
// the messages array, so the counter must move exactly when the review set
// can change and never move backwards (#603).

function withAssistant(id = "a1"): ChatState {
  return reducer({ ...initialChatState, busy: true }, { type: "assistantStart", id })
}

function edit(status: ToolUpdate["status"], callID = "c1"): ToolUpdate {
  return {
    callID,
    tool: "edit",
    status,
    input: { filePath: "src/foo.ts" },
    metadata: { filediff: { patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1 } },
  }
}

describe("reducer reviewRevision", () => {
  it("starts at 0 and ignores events that cannot change the review set", () => {
    let state = withAssistant()
    expect(state.reviewRevision).toBe(0)
    state = reducer(state, { type: "textDelta", id: "a1", delta: "hello" })
    state = reducer(state, { type: "reasoningDelta", id: "a1", delta: "hmm" })
    state = reducer(state, { type: "tool", id: "a1", update: edit("running") })
    state = reducer(state, { type: "tool", id: "a1", update: edit("pending") })
    state = reducer(state, { type: "reviewHunkState", key: "tool:src/foo.ts:h1", state: "kept" })
    state = reducer(state, { type: "userMessage", id: "u2", text: "next" })
    state = reducer(state, { type: "assistantStart", id: "a2" })
    state = reducer(state, { type: "assistantDone", id: "a2" })
    expect(state.reviewRevision).toBe(0)
  })

  it("bumps once per completed tool, patch, restore, and real removal", () => {
    let state = withAssistant()
    state = reducer(state, { type: "tool", id: "a1", update: edit("running") })
    state = reducer(state, { type: "tool", id: "a1", update: edit("completed") })
    expect(state.reviewRevision).toBe(1)
    state = reducer(state, { type: "patch", id: "a1", files: ["src/bar.ts"], diff: "diff --git a/src/bar.ts b/src/bar.ts\n" })
    expect(state.reviewRevision).toBe(2)
    state = reducer(state, { type: "messageRemoved", id: "nope" })
    expect(state.reviewRevision).toBe(2)
    state = reducer(state, { type: "messageRemoved", id: "a1" })
    expect(state.reviewRevision).toBe(3)
    state = reducer(state, { type: "restore", conversationID: "c2", messages: [] })
    expect(state.reviewRevision).toBe(4)
  })

  it("clear and reset keep it monotonic instead of returning to 0", () => {
    let state = withAssistant()
    state = reducer(state, { type: "tool", id: "a1", update: edit("completed") })
    expect(state.reviewRevision).toBe(1)
    const cleared = reducer(state, { type: "clear" })
    expect(cleared.messages).toEqual([])
    expect(cleared.reviewRevision).toBe(2)
    const reset = reducer(cleared, { type: "reset" })
    expect(reset.reviewRevision).toBe(3)
  })
})
