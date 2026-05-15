import { describe, it, expect } from "vitest"
import { reducer, initialChatState } from "../../webview/src/hooks/useChatState"

describe("reducer continuationPending", () => {
  it("starts false on a fresh state", () => {
    expect(initialChatState.continuationPending).toBe(false)
  })

  it("continuationPending: true sets the flag", () => {
    const next = reducer(initialChatState, { type: "continuationPending", pending: true })
    expect(next.continuationPending).toBe(true)
  })

  it("continuationPending: false clears the flag", () => {
    const set = reducer(initialChatState, { type: "continuationPending", pending: true })
    const cleared = reducer(set, { type: "continuationPending", pending: false })
    expect(cleared.continuationPending).toBe(false)
  })

  it("sessionBusy clears continuationPending (continuation took over)", () => {
    const pending = reducer(
      { ...initialChatState, busy: true },
      { type: "continuationPending", pending: true },
    )
    expect(pending.continuationPending).toBe(true)
    const busy = reducer(pending, { type: "sessionBusy" })
    expect(busy.busy).toBe(true)
    expect(busy.continuationPending).toBe(false)
  })

  it("sessionIdle clears continuationPending (defer timed out)", () => {
    const pending = reducer(
      { ...initialChatState, busy: true },
      { type: "continuationPending", pending: true },
    )
    const idle = reducer(pending, { type: "sessionIdle" })
    expect(idle.busy).toBe(false)
    expect(idle.continuationPending).toBe(false)
  })

  it("busy stays true while continuationPending is true", () => {
    // The host keeps busy=true and just signals pending — the reducer
    // must not flip busy on the pending event itself.
    const before = { ...initialChatState, busy: true }
    const after = reducer(before, { type: "continuationPending", pending: true })
    expect(after.busy).toBe(true)
  })
})
