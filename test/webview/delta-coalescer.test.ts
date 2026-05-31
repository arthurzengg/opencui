import { describe, it, expect } from "vitest"
import { createDeltaCoalescer } from "../../webview/src/delta-coalescer"
import type { Action } from "../../webview/src/hooks/useChatState"

// A manually-driven requestAnimationFrame so tests flush on demand.
function manualRaf() {
  let cb: (() => void) | null = null
  const raf = (fn: () => void) => {
    cb = fn
  }
  const tick = () => {
    const c = cb
    cb = null
    c?.()
  }
  return { raf, tick }
}

describe("createDeltaCoalescer", () => {
  it("merges consecutive same-id textDeltas into one dispatch", () => {
    const dispatched: Action[] = []
    const { raf, tick } = manualRaf()
    const c = createDeltaCoalescer((a) => dispatched.push(a), raf)
    c.enqueue({ type: "textDelta", id: "a1", delta: "Hel" } as Action)
    c.enqueue({ type: "textDelta", id: "a1", delta: "lo" } as Action)
    c.enqueue({ type: "textDelta", id: "a1", delta: " world" } as Action)
    expect(dispatched).toHaveLength(0) // nothing dispatched until the frame fires
    tick()
    expect(dispatched).toEqual([{ type: "textDelta", id: "a1", delta: "Hello world" }])
  })

  it("does not merge deltas for different message ids", () => {
    const dispatched: Action[] = []
    const { raf, tick } = manualRaf()
    const c = createDeltaCoalescer((a) => dispatched.push(a), raf)
    c.enqueue({ type: "textDelta", id: "a1", delta: "x" } as Action)
    c.enqueue({ type: "textDelta", id: "a2", delta: "y" } as Action)
    tick()
    expect(dispatched).toEqual([
      { type: "textDelta", id: "a1", delta: "x" },
      { type: "textDelta", id: "a2", delta: "y" },
    ])
  })

  it("does not merge textDelta with reasoningDelta", () => {
    const dispatched: Action[] = []
    const { raf, tick } = manualRaf()
    const c = createDeltaCoalescer((a) => dispatched.push(a), raf)
    c.enqueue({ type: "textDelta", id: "a1", delta: "x" } as Action)
    c.enqueue({ type: "reasoningDelta", id: "a1", delta: "y" } as Action)
    tick()
    expect(dispatched).toHaveLength(2)
  })

  it("preserves order when a tool interleaves two text deltas", () => {
    const dispatched: Action[] = []
    const { raf, tick } = manualRaf()
    const c = createDeltaCoalescer((a) => dispatched.push(a), raf)
    c.enqueue({ type: "textDelta", id: "a1", delta: "before" } as Action)
    c.enqueue({ type: "tool", id: "a1", update: { callID: "c", tool: "read", status: "running" } } as Action)
    c.enqueue({ type: "textDelta", id: "a1", delta: "after" } as Action)
    tick()
    expect(dispatched.map((a) => a.type)).toEqual(["textDelta", "tool", "textDelta"])
    expect((dispatched[0] as { delta: string }).delta).toBe("before")
    expect((dispatched[2] as { delta: string }).delta).toBe("after")
  })

  it("schedules one frame per burst and re-arms after a flush", () => {
    const dispatched: Action[] = []
    let rafCalls = 0
    let cb: (() => void) | null = null
    const raf = (fn: () => void) => {
      rafCalls++
      cb = fn
    }
    const c = createDeltaCoalescer((a) => dispatched.push(a), raf)
    c.enqueue({ type: "textDelta", id: "a1", delta: "a" } as Action)
    c.enqueue({ type: "textDelta", id: "a1", delta: "b" } as Action)
    expect(rafCalls).toBe(1) // both queued under a single scheduled frame
    cb?.()
    c.enqueue({ type: "textDelta", id: "a1", delta: "c" } as Action)
    expect(rafCalls).toBe(2) // a fresh frame is scheduled only after the prior flush
  })
})
