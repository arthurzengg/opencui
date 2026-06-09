import { describe, it, expect } from "vitest"
import { reducer, initialChatState } from "../../webview/src/hooks/useChatState"
import type { QuestionInfo } from "../../webview/src/protocol"

const question: QuestionInfo = {
  question: "Pick one",
  header: "Pick",
  options: [
    { label: "A", description: "first" },
    { label: "B", description: "second" },
  ],
}

describe("reducer — question flow", () => {
  it("question action stores pendingQuestion with id + questions", () => {
    const state = reducer(initialChatState, {
      type: "question",
      id: "que_1",
      questions: [question],
    })
    expect(state.pendingQuestion?.id).toBe("que_1")
    expect(state.pendingQuestion?.questions).toHaveLength(1)
  })

  it("questionResolved clears the matching pendingQuestion", () => {
    const opened = reducer(initialChatState, {
      type: "question",
      id: "que_1",
      questions: [question],
    })
    const closed = reducer(opened, { type: "questionResolved", id: "que_1" })
    expect(closed.pendingQuestion).toBeUndefined()
  })

  it("questionResolved with a non-matching id is a no-op", () => {
    const opened = reducer(initialChatState, {
      type: "question",
      id: "que_active",
      questions: [question],
    })
    const stale = reducer(opened, { type: "questionResolved", id: "que_other" })
    expect(stale.pendingQuestion?.id).toBe("que_active")
  })

  it("clearQuestion action also clears the matching pendingQuestion", () => {
    const opened = reducer(initialChatState, {
      type: "question",
      id: "que_1",
      questions: [question],
    })
    const closed = reducer(opened, { type: "clearQuestion", id: "que_1" })
    expect(closed.pendingQuestion).toBeUndefined()
  })

  it("restore (conversation switch) dismisses an open question, like pendingPermission", () => {
    const opened = reducer(initialChatState, {
      type: "question",
      id: "que_1",
      questions: [question],
    })
    const switched = reducer(opened, {
      type: "restore",
      conversationID: "conv_b",
      messages: [],
    })
    // The host already dropped the old session's activeQuestions without
    // posting questionResolved — without this clear, A's dialog renders
    // forever in conversation B.
    expect(switched.pendingQuestion).toBeUndefined()
  })
})
