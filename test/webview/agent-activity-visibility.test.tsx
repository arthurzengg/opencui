import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import App from "../../webview/src/App"
import type { AgentsStatusInfo, AgentsTaskInfo } from "../../webview/src/protocol"
import { hasSubagentWork } from "../../webview/src/components/AgentActivity"
import { post } from "./host-messages"

afterEach(cleanup)

const main: AgentsTaskInfo = { id: "main:c:s:t", kind: "main", title: "go", status: "running", startedAt: 0, updatedAt: 0 }
const sub = (i: number, status: AgentsTaskInfo["status"] = "running"): AgentsTaskInfo => ({
  id: `subagent:child:s${i}`, kind: "subagent", title: `Task ${i}`, status, startedAt: 0, updatedAt: 0,
})
/** The wire shape: counts derived from the active rows, total equal to their number. */
function status(...tasks: AgentsTaskInfo[]): AgentsStatusInfo {
  const count = (s: AgentsTaskInfo["status"]) => tasks.filter((t) => t.status === s).length
  return { running: count("running"), waiting: count("waiting"), error: count("error"), total: tasks.length, tasks }
}

function setup() {
  const { container } = render(<App />)
  return {
    pill: () => container.querySelector(".agent-activity"),
    thinking: () => container.querySelector(".thinking-dots"),
  }
}

describe("hasSubagentWork", () => {
  it("is false for no status, an empty status, and a Main-only status", () => {
    expect(hasSubagentWork(undefined)).toBe(false)
    expect(hasSubagentWork(status())).toBe(false)
    expect(hasSubagentWork(status(main))).toBe(false)
  })

  it("is true for any subagent row, whatever its status", () => {
    expect(hasSubagentWork(status(main, sub(1)))).toBe(true)
    expect(hasSubagentWork(status(sub(1, "error")))).toBe(true)
  })
})

describe("Agents pill visibility (#680)", () => {
  it("shows no pill for a Main-only reply, whose thinking line keeps breathing", async () => {
    const t = setup()
    await post({ type: "userMessage", id: "u1", text: "go" }, { type: "assistantStart", id: "a1" })
    await post({ type: "agentsStatus", status: status(main) })
    expect(t.pill()).toBeNull()
    expect(t.thinking()?.classList.contains("live-breathe")).toBe(true)
  })

  it("shows the pill when the first subagent row arrives and quiets the thinking line", async () => {
    const t = setup()
    await post({ type: "userMessage", id: "u1", text: "go" }, { type: "assistantStart", id: "a1" })
    await post({ type: "agentsStatus", status: status(main, sub(1)) })
    expect(t.pill()).not.toBeNull()
    expect(t.thinking()?.classList.contains("live-breathe")).toBe(false)
  })

  it("keeps the pill for an errored subagent after the turn settled", async () => {
    const t = setup()
    await post({ type: "userMessage", id: "u1", text: "go" }, { type: "assistantStart", id: "a1" })
    await post({ type: "agentsStatus", status: status(main, sub(1)) })
    await post({ type: "assistantDone", id: "a1" }, { type: "sessionIdle" })
    await post({ type: "agentsStatus", status: status(sub(1, "error")) })
    expect(t.pill()).not.toBeNull()
    await post({ type: "agentsStatus", status: status() })
    expect(t.pill()).toBeNull()
  })
})
