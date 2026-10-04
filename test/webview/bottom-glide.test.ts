import { describe, it, expect } from "vitest"
import { createBottomGlide, nestedScrollerTakesWheelUp } from "../../webview/src/bottom-glide"

function harness(start: { top: number; height: number; client?: number }) {
  const box = { scrollTop: start.top, scrollHeight: start.height, clientHeight: start.client ?? 400 }
  let following = true
  const queue = new Map<number, FrameRequestCallback>()
  let nextID = 1
  let clock = 0
  const writes: number[] = []
  const glide = createBottomGlide({
    box: () => (following ? box : null),
    write: (top) => {
      box.scrollTop = Math.min(top, box.scrollHeight - box.clientHeight)
      writes.push(box.scrollTop)
    },
    raf: (cb) => {
      queue.set(nextID, cb)
      return nextID++
    },
    cancelRaf: (id) => queue.delete(id),
  })
  return {
    box,
    glide,
    writes,
    pending: () => queue.size,
    drop: () => (following = false),
    /** Run one 16ms frame; returns false when nothing was scheduled. */
    frame() {
      const callbacks = [...queue.values()]
      queue.clear()
      clock += 16
      for (const cb of callbacks) cb(clock)
      return callbacks.length > 0
    },
    settle(max = 200) {
      let n = 0
      while (this.frame() && ++n < max);
      return n
    },
  }
}

describe("createBottomGlide (#676)", () => {
  it("takes the first step at once and eases the rest of the way over frames", () => {
    const h = harness({ top: 600, height: 1150 })
    h.glide.start()
    expect(h.box.scrollTop).toBeGreaterThan(600)
    expect(h.box.scrollTop).toBeLessThan(750)
    const frames = h.settle()
    expect(h.box.scrollTop).toBe(750)
    expect(frames).toBeGreaterThan(3)
    expect(frames).toBeLessThan(20)
    expect(h.pending()).toBe(0)
  })

  it("moves forward on every frame and never past the bottom", () => {
    const h = harness({ top: 0, height: 700 })
    h.glide.start()
    h.settle()
    for (let i = 1; i < h.writes.length; i++) expect(h.writes[i]).toBeGreaterThan(h.writes[i - 1])
    expect(Math.max(...h.writes)).toBe(300)
  })

  it("extends to content that arrives mid-glide without a second loop", () => {
    const h = harness({ top: 600, height: 1150 })
    h.glide.start()
    h.frame()
    h.box.scrollHeight = 1400
    h.glide.start()
    expect(h.pending()).toBe(1)
    h.settle()
    expect(h.box.scrollTop).toBe(1000)
  })

  it("ends when following is dropped", () => {
    const h = harness({ top: 600, height: 1150 })
    h.glide.start()
    h.frame()
    const at = h.box.scrollTop
    h.drop()
    h.settle()
    expect(h.box.scrollTop).toBe(at)
    expect(h.pending()).toBe(0)
  })

  it("stop cancels the pending frame", () => {
    const h = harness({ top: 600, height: 1150 })
    h.glide.start()
    const at = h.box.scrollTop
    h.glide.stop()
    expect(h.pending()).toBe(0)
    expect(h.frame()).toBe(false)
    expect(h.box.scrollTop).toBe(at)
  })

  it("does nothing when already at the bottom", () => {
    const h = harness({ top: 600, height: 1000 })
    h.glide.start()
    expect(h.writes).toEqual([])
    expect(h.pending()).toBe(0)
  })
})

describe("nestedScrollerTakesWheelUp", () => {
  it("is true only when an element between the target and the container can still scroll up", () => {
    const container = document.createElement("div")
    const nested = document.createElement("div")
    const leaf = document.createElement("span")
    nested.appendChild(leaf)
    container.appendChild(nested)
    expect(nestedScrollerTakesWheelUp(leaf, container)).toBe(false)
    nested.scrollTop = 20
    expect(nestedScrollerTakesWheelUp(leaf, container)).toBe(true)
    container.scrollTop = 50
    nested.scrollTop = 0
    expect(nestedScrollerTakesWheelUp(leaf, container)).toBe(false)
  })
})
