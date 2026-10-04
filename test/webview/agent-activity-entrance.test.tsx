import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import App from "../../webview/src/App"
import type { AgentsStatusInfo, Outbound } from "../../webview/src/protocol"

afterEach(cleanup)

const css = readFileSync(path.resolve(__dirname, "../../webview/src/styles.css"), "utf8")

/** Host messages reach the reducer in one batch per animation frame. */
async function post(...messages: Outbound[]) {
  await act(async () => {
    for (const data of messages) window.dispatchEvent(new MessageEvent("message", { data }))
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
}

function status(total: number): AgentsStatusInfo {
  const tasks = Array.from({ length: total }, (_, i) => ({
    id: `subagent:child:s${i}`,
    kind: "subagent" as const,
    title: `Task ${i}`,
    status: "running" as const,
    startedAt: 0,
    updatedAt: 0,
  }))
  return { running: total, waiting: 0, error: 0, total, tasks }
}

describe("Agents pill entrance (#674)", () => {
  // A turn creates a new assistant message per step and the pill follows the
  // active one, so it remounts while the work goes on. Only the message it
  // appeared in may carry the entrance class, or the fade replays every step.
  it("fades in when work starts, not when it moves to the next step's message", async () => {
    const { container } = render(<App />)
    const pills = () => Array.from(container.querySelectorAll<HTMLElement>(".agent-activity"))

    await post({ type: "userMessage", id: "u1", text: "go" }, { type: "assistantStart", id: "a1" })
    await post({ type: "agentsStatus", status: status(1) })
    expect(pills()).toHaveLength(1)
    expect(pills()[0].classList.contains("is-entering")).toBe(true)

    await post({ type: "assistantDone", id: "a1" }, { type: "assistantStart", id: "a2" })
    expect(pills()).toHaveLength(1)
    expect(container.querySelectorAll(".msg.role-assistant")[1].contains(pills()[0])).toBe(true)
    expect(pills()[0].classList.contains("is-entering")).toBe(false)

    await post({ type: "agentsStatus", status: status(2) })
    expect(pills()[0].classList.contains("is-entering")).toBe(false)

    await post({ type: "agentsStatus", status: status(0) })
    expect(pills()).toHaveLength(0)

    await post({ type: "agentsStatus", status: status(1) })
    expect(pills()).toHaveLength(1)
    expect(pills()[0].classList.contains("is-entering")).toBe(true)
  })

  it("animates only through the entering class and turns it off under reduced motion", () => {
    expect(css).toMatch(/@keyframes agent-activity-in \{\s*from \{ opacity: 0; \}\s*\}/)
    expect(css).toMatch(/\n\.agent-activity\.is-entering \{\s*animation: agent-activity-in 0\.2s ease;\s*\}/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.agent-activity\.is-entering \{ animation: none; \}/)
    const bare = css.slice(css.indexOf("\n.agent-activity {"), css.indexOf("\n}", css.indexOf("\n.agent-activity {")))
    expect(bare).not.toMatch(/animation\s*:/)
  })
})
