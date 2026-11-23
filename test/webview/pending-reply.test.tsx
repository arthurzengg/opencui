import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import App from "../../webview/src/App"
import { post } from "./host-messages"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// A sent prompt is answered at once: the Thinking line is drawn before the
// server opens the reply, and the reply takes that line over (#798).
describe("the Thinking line before the reply exists", () => {
  it("shows with the prompt and hands over to the reply without doubling", async () => {
    const { container } = render(<App />)
    await post({ type: "userMessage", id: "u1", text: "hello" })
    expect(container.querySelectorAll(".process.is-bare")).toHaveLength(1)
    expect(container.querySelector(".turn .pending-reply .process-title")?.textContent).toBe("Thinking")

    await post({ type: "assistantStart", id: "a1" })
    expect(container.querySelector(".pending-reply")).toBeNull()
    expect(container.querySelectorAll(".process.is-bare")).toHaveLength(1)
  })

  it("leaves when the turn ends with no reply, and when the user stops it", async () => {
    const { container } = render(<App />)
    await post({ type: "userMessage", id: "u1", text: "hello" })
    await post({ type: "sessionIdle" })
    expect(container.querySelector(".process")).toBeNull()

    await post({ type: "userMessage", id: "u2", text: "again" })
    expect(container.querySelector(".pending-reply")).not.toBeNull()
    await post({ type: "aborted" })
    expect(container.querySelector(".pending-reply")).toBeNull()
  })

  // The time on the line is the panel's own: it starts when the prompt is
  // sent and carries over to the reply. A turn the panel did not see begin
  // has no start to count from, so its line shows none.
  it("counts from the moment of sending, and not at all for a turn it did not see begin", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    const { container } = render(<App />)
    await post({ type: "userMessage", id: "u1", text: "hello" })
    act(() => {
      vi.advanceTimersByTime(3100)
    })
    expect(container.querySelector(".pending-reply .process-elapsed")?.textContent).toBe("3s")
    await post({ type: "assistantStart", id: "a1" })
    expect(container.querySelector(".process.is-bare .process-elapsed")?.textContent).toBe("3s")

    await post({
      type: "restore",
      conversationID: "c2",
      messages: [{ id: "u9", role: "user", blocks: [{ type: "text", text: "sent before the panel loaded" }] }],
    })
    await post({ type: "sessionBusy" }, { type: "assistantStart", id: "a9" })
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(container.querySelector(".process.is-bare")).not.toBeNull()
    expect(container.querySelector(".process-elapsed")).toBeNull()
  })
})
