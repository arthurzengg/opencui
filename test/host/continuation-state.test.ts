import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ContinuationState } from "../../src/chat/continuation-state"
import type { Outbound } from "../../src/protocol"

describe("ContinuationState deferred idle", () => {
  let posts: Outbound[]
  let emitIdleCalls: number
  let subagents: number

  beforeEach(() => {
    vi.useFakeTimers()
    posts = []
    emitIdleCalls = 0
    subagents = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function make() {
    return new ContinuationState({
      post: (msg) => posts.push(msg),
      activeSubagentCount: () => subagents,
      emitIdle: () => emitIdleCalls++,
    })
  }

  it("structural defer + grace timer runs the FULL idle settlement, not just a webview post", () => {
    const cs = make()
    subagents = 1
    cs.beginDefer("sessionIdle")
    expect(posts).toEqual([{ type: "continuationPending", pending: true }])

    // Subagent settles; ChatView calls collapseToGraceIfSettled.
    subagents = 0
    cs.collapseToGraceIfSettled()
    expect(emitIdleCalls).toBe(0)

    vi.advanceTimersByTime(10_000)
    // The settlement callback is what marks the task store idle and clears
    // the Main task ID — the regression was posting sessionIdle directly.
    expect(emitIdleCalls).toBe(1)
    expect(posts).toEqual([
      { type: "continuationPending", pending: true },
      { type: "continuationPending", pending: false },
    ])
  })

  it("toast-only defer settles via emitIdle when the cap expires", () => {
    const cs = make()
    cs.markSignal("toast")
    expect(cs.hasGate()).toBe(true)

    cs.beginDefer("sessionIdle")
    vi.advanceTimersByTime(120_000)
    expect(emitIdleCalls).toBe(1)
  })

  it("timer no-ops while subagents are still active", () => {
    const cs = make()
    cs.markSignal("toast")
    cs.beginDefer("sessionIdle")
    subagents = 1
    vi.advanceTimersByTime(120_000)
    expect(emitIdleCalls).toBe(0)
  })

  it("finishPending cancels the deferred settlement", () => {
    const cs = make()
    cs.markSignal("toast")
    cs.beginDefer("sessionIdle")
    cs.finishPending()
    vi.advanceTimersByTime(120_000)
    expect(emitIdleCalls).toBe(0)
  })
})
