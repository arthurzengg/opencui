import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
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
})

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

describe("following a streaming turn (#676)", () => {
  it("follows growth of the live turn that arrives without a new message", async () => {
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
})
