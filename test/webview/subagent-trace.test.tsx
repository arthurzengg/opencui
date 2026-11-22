import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import type { ReactElement } from "react"
import { ToolTrace } from "../../webview/src/components/ToolCard"
import { MessageView } from "../../webview/src/components/MessageView"
import { AgentTasksContext, TurnContext } from "../../webview/src/trace-context"
import type { Message } from "../../webview/src/hooks/useChatState"
import type { AgentsTaskInfo, ReviewChangeActor, ToolUpdate } from "../../webview/src/protocol"

afterEach(cleanup)

const explore: ReviewChangeActor = { kind: "subagent", sessionID: "ses_child", subagent: "explore", callID: "call_task" }

function update(callID: string, tool: string, input: Record<string, unknown>, status: ToolUpdate["status"] = "completed", rest: Partial<ToolUpdate> = {}): ToolUpdate {
  return { callID, tool, status, input, ...rest }
}

const task = (over: Partial<AgentsTaskInfo> = {}): AgentsTaskInfo => ({
  id: "subagent:child:ses_child",
  kind: "subagent",
  callID: "call_task",
  title: "Find the subscription",
  subagent: "explore",
  status: "running",
  startedAt: Date.now() - 34_000,
  updatedAt: Date.now(),
  ...over,
})

function show(ui: ReactElement, { tasks = [], live = false, stopped = false }: { tasks?: AgentsTaskInfo[]; live?: boolean; stopped?: boolean } = {}) {
  return render(
    <AgentTasksContext.Provider value={tasks}>
      <TurnContext.Provider value={{ live, stopped }}>{ui}</TurnContext.Provider>
    </AgentTasksContext.Provider>,
  )
}

const dispatch = (status: ToolUpdate["status"], rest: Partial<ToolUpdate> = {}) =>
  update("call_task", "task", { subagent_type: "explore", description: "Find the subscription", prompt: "...", run_in_background: false }, status, rest)
const childCalls = [
  { update: update("c1", "read", { filePath: "src/foo.ts" }), actor: explore },
  { update: update("c2", "read", { filePath: "src/bar.ts" }), actor: explore },
  { update: update("c3", "grep", { pattern: "subscribe" }), actor: explore },
]

describe("a subagent in the trace (#796)", () => {
  // It used to be a tool row reading "Investigated", with every call of the
  // agent listed under it and its state in a separate list.
  it("is one row: its task, who has it and its latest step, with its calls folded", () => {
    const { container } = show(
      <ToolTrace tools={[{ update: update("c_main", "read", { filePath: "src/foo.ts" }) }, { update: dispatch("running", { time: { start: Date.now() - 34_000 } }) }, ...childCalls]} />,
      { tasks: [task()], live: true },
    )
    const row = container.querySelector(".agent-row")!
    expect(row.className).toContain("is-working")
    expect(row.querySelector(".agent-row-title")?.textContent).toBe("Find the subscription")
    expect(row.querySelector(".agent-row-line")?.textContent).toBe("Explore · Grepped subscribe")
    expect(row.querySelector(".agent-row-side")?.textContent).toBe("34s")
    expect(row.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("working")
    expect(container.querySelector(".other-row")).toBeNull()
    // The parent's reads line counts its own read alone; the agent's calls are folded away.
    expect(container.querySelectorAll(".trace-reads-count")).toHaveLength(1)
    expect(container.querySelector(".trace-reads-count")?.textContent).toBe("1")
  })

  it("opens the agent's calls on a click", () => {
    const { container } = show(
      <ToolTrace tools={[{ update: dispatch("completed", { time: { start: 1000, end: 42_000 }, metadata: { agent: "explore", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } } }) }, ...childCalls]} />,
    )
    const head = container.querySelector(".agent-row-head")!
    expect(head.getAttribute("aria-expanded")).toBe("false")
    expect(container.querySelector(".agent-row-side")?.textContent).toBe("Explore · 41s")
    expect(container.querySelector(".agent-row-line")).toBeNull()

    fireEvent.click(head)
    expect(head.getAttribute("aria-expanded")).toBe("true")
    const steps = container.querySelector(".agent-row-steps")!
    expect(steps.querySelector(".agent-row-meta")?.textContent).toBe("Sonnet 5.5 · 3 steps")
    expect(steps.querySelector(".trace-reads-count")?.textContent).toBe("2")
    expect(steps.querySelectorAll(".other-row")).toHaveLength(1)
  })

  it("says so on the row when the agent needs the user", () => {
    const { container } = show(<ToolTrace tools={[{ update: dispatch("running") }]} />, { tasks: [task({ status: "waiting" })], live: true })
    const row = container.querySelector(".agent-row")!
    expect(row.className).toContain("is-waiting")
    expect(row.querySelector(".agent-row-side")?.textContent).toBe("Needs approval")
    expect(row.querySelector(".agent-row-line")?.textContent).toBe("Explore · Waiting for you")
  })

  // Recorded from 1.18.30: a stop closes the call as `error`, with
  // `Tool execution aborted` and `metadata.interrupted`.
  it("keeps a stop neutral, and the calls the agent got through", () => {
    const closed = { error: "Tool execution aborted", metadata: { interrupted: true }, time: { start: 1000, end: 32_000 } }
    const { container } = show(
      <ToolTrace
        tools={[
          { update: dispatch("error", closed) },
          { update: update("c1", "read", { filePath: "src/foo.ts" }), actor: explore },
          { update: update("c4", "bash", { command: "bun run test" }, "error", closed), actor: explore },
          { update: update("c_main", "bash", { command: "git status" }, "error", closed) },
        ]}
      />,
      { stopped: true },
    )
    const row = container.querySelector(".agent-row")!
    expect(row.className).toContain("is-stopped")
    expect(row.querySelector(".agent-row-side")?.textContent).toBe("Stopped · 31s")
    expect(row.querySelector(".agent-row-reason")).toBeNull()

    fireEvent.click(row.querySelector(".agent-row-head")!)
    expect(row.querySelector(".trace-reads-count")?.textContent).toBe("1")
    expect(row.querySelector(".other-row")?.className).toContain("status-stopped")
    // The main agent's own stopped call is neutral too.
    const own = container.querySelector(".trace > .trace-others > .other-row")!
    expect(own.className).toContain("status-stopped")
    expect(own.querySelector(".other-stopped")?.textContent).toBe("Stopped")
    expect(container.querySelector(".other-error")).toBeNull()
  })

  // Recorded: with oh-my-openagent the call launches the agent and returns;
  // the failure arrives on the live task.
  it("gives a failure its reason", () => {
    const reason = "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."
    const launched = update("call_task", "task", { subagent_type: "oracle", description: "Recheck visual quality", prompt: "...", run_in_background: true }, "completed", {
      output: "Background task launched.",
      time: { start: 1000, end: 1200 },
    })
    const { container } = show(<ToolTrace tools={[{ update: launched }]} />, { tasks: [task({ status: "error", error: reason, subagent: "oracle" })], live: true })
    const row = container.querySelector(".agent-row")!
    expect(row.className).toContain("is-failed")
    expect(row.querySelector(".agent-row-reason")?.textContent).toBe(reason)
    expect(row.querySelector(".agent-row-line")?.textContent).toBe(`Oracle · ${reason}`)
    // Nothing to open: the agent never made a call.
    expect(row.querySelector(".agent-row-head")?.getAttribute("aria-disabled")).toBe("true")
  })

  it("names the agent for calls the host could not tie to a row", () => {
    const { container } = show(
      <ToolTrace tools={[{ update: update("c1", "read", { filePath: "src/foo.ts" }), actor: { kind: "subagent", sessionID: "ses_child", subagent: "explore" } }]} />,
    )
    const row = container.querySelector(".agent-row")!
    expect(row.querySelector(".agent-row-title")?.textContent).toBe("Explore agent")
    fireEvent.click(row.querySelector(".agent-row-head")!)
    expect(row.querySelector(".trace-reads-count")?.textContent).toBe("1")
  })
})

describe("a folded block while agents work (#796)", () => {
  // The Agents pill used to say this; with the rows folded away nothing did.
  it("says how many agents are at work on its head, until it is opened", () => {
    const message: Message = { id: "a1", role: "assistant", pending: true, blocks: [{ type: "tool", update: dispatch("running") }] }
    const { container } = render(
      <AgentTasksContext.Provider value={[task(), task({ id: "subagent:child:ses_2", callID: "call_2" })]}>
        <MessageView message={message} processOpen={false} processOnly={false} />
      </AgentTasksContext.Provider>,
    )
    expect(container.querySelector(".process-agents")?.textContent).toBe("2 agents working")
    fireEvent.click(container.querySelector(".process-head")!)
    expect(container.querySelector(".process-agents")).toBeNull()
    expect(container.querySelector(".agent-row")).not.toBeNull()
  })
})
