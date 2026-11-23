import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import App from "../../webview/src/App"
import { post } from "./host-messages"

afterEach(cleanup)

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
})
