import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import App from "../../webview/src/App"
import type { Outbound } from "../../webview/src/protocol"

type Observed = { callback: ResizeObserverCallback; targets: Set<Element> }
let observers: Observed[] = []

class ResizeObserverMock {
  private entry: Observed
  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, targets: new Set() }
    observers.push(this.entry)
  }
  observe(el: Element) { this.entry.targets.add(el) }
  unobserve(el: Element) { this.entry.targets.delete(el) }
  disconnect() { this.entry.targets.clear() }
}

const original = globalThis.ResizeObserver
beforeEach(() => {
  observers = []
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
})
afterEach(() => {
  cleanup()
  globalThis.ResizeObserver = original
  delete (window as { matchMedia?: unknown }).matchMedia
})

function reduceMotion() {
  window.matchMedia = ((query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" })) as typeof window.matchMedia
}

async function frames(n: number) {
  for (let i = 0; i < n; i++) await new Promise((resolve) => requestAnimationFrame(resolve))
}

/** Host messages reach the reducer in one batch per animation frame. */
async function post(...messages: Outbound[]) {
  await act(async () => {
    for (const data of messages) window.dispatchEvent(new MessageEvent("message", { data }))
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
}

/** App with a 400px transcript viewport whose content height the test sets. */
function setup() {
  const { container } = render(<App />)
  const box = container.querySelector(".messages") as HTMLElement
  let height = 0
  Object.defineProperty(box, "clientHeight", { configurable: true, value: 400 })
  Object.defineProperty(box, "clientWidth", { configurable: true, value: 390 })
  Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => height })
  return {
    box,
    grow(to: number) { height = to },
    lastTurn: () => Array.from(box.querySelectorAll(".turn")).at(-1)!,
    resize(el: Element) {
      act(() => {
        for (const o of observers) if (o.targets.has(el)) o.callback([], {} as ResizeObserver)
      })
    },
    // The browser answers each scrollTop write with one scroll event; jsdom
    // does not, so emit it before a user gesture as the browser would have.
    userScrollTo(top: number) {
      fireEvent.scroll(box)
      box.scrollTop = top
      fireEvent.scroll(box)
    },
  }
}

/** A turn that is live and stuck to the bottom at 600 of 1000. */
async function streaming() {
  const t = setup()
  t.grow(1000)
  await post({ type: "userMessage", id: "u1", text: "go" }, { type: "assistantStart", id: "a1" })
  return t
}

describe("following a streaming turn (#676)", () => {
  it("follows growth of the live turn that arrives without a new message, on the same frame", async () => {
    reduceMotion()
    const t = setup()
    t.grow(1000)
    await post({ type: "userMessage", id: "u1", text: "go" }, { type: "assistantStart", id: "a1" })
    expect(t.box.scrollTop).toBe(600)

    // e.g. the Process box unfolding between steps
    t.grow(1150)
    t.resize(t.lastTurn())
    expect(t.box.scrollTop).toBe(750)
  })

  it("leaves the view alone once the user has scrolled up", async () => {
    const t = setup()
    t.grow(1000)
    await post({ type: "userMessage", id: "u1", text: "go" }, { type: "assistantStart", id: "a1" })
    t.userScrollTo(300)

    t.grow(1300)
    t.resize(t.lastTurn())
    expect(t.box.scrollTop).toBe(300)
  })

  it("does not follow resizes when no turn is live", async () => {
    const t = setup()
    t.grow(1000)
    await post({ type: "userMessage", id: "u1", text: "go" }, { type: "assistantStart", id: "a1" })
    await post({ type: "assistantDone", id: "a1" }, { type: "sessionIdle" })
    expect(t.box.scrollTop).toBe(600)

    // e.g. the user expanding a block near the bottom
    t.grow(1200)
    t.resize(t.lastTurn())
    expect(t.box.scrollTop).toBe(600)
  })

  it("glides to the new bottom instead of jumping, without overshooting", async () => {
    const t = await streaming()
    expect(t.box.scrollTop).toBe(600)

    t.grow(1150)
    t.resize(t.lastTurn())
    const first = t.box.scrollTop
    expect(first).toBeGreaterThan(600)
    expect(first).toBeLessThan(750)

    const seen: number[] = []
    await waitFor(() => {
      seen.push(t.box.scrollTop)
      expect(t.box.scrollTop).toBe(750)
    })
    expect(Math.max(...seen)).toBeLessThanOrEqual(750)
  })

  it("jumps when the gap is larger than the viewport", async () => {
    const t = await streaming()
    t.grow(1700)
    t.resize(t.lastTurn())
    expect(t.box.scrollTop).toBe(1300)
  })

  it("jumps when sending pins the new question to the top", async () => {
    const t = await streaming()
    await post({ type: "assistantDone", id: "a1" }, { type: "sessionIdle" })

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: "next" } })
    fireEvent.keyDown(textarea, { key: "Enter" })
    t.grow(1200)
    await post({ type: "userMessage", id: "u2", text: "next" })
    expect(t.box.scrollTop).toBe(800)
  })

  it("stops gliding at once on an upward wheel over the transcript", async () => {
    const t = await streaming()
    t.grow(1150)
    t.resize(t.lastTurn())
    const at = t.box.scrollTop
    expect(at).toBeLessThan(750)

    fireEvent.wheel(t.box, { deltaY: -100 })
    await frames(10)
    expect(t.box.scrollTop).toBe(at)
  })

  it("keeps following when the upward wheel belongs to a nested scroller", async () => {
    const t = await streaming()
    const nested = t.lastTurn().querySelector(".msg") as HTMLElement
    nested.scrollTop = 30
    t.grow(1150)
    t.resize(t.lastTurn())

    fireEvent.wheel(nested, { deltaY: -100 })
    await waitFor(() => expect(t.box.scrollTop).toBe(750))
  })

  it("stops following when the user grabs the scrollbar", async () => {
    const t = await streaming()
    t.box.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 395 }))
    t.grow(1150)
    t.resize(t.lastTurn())
    await frames(10)
    expect(t.box.scrollTop).toBe(600)
  })
})
