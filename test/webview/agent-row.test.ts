import { describe, expect, it } from "vitest"
import { agentKind, agentModel, agentsNote, agentState, callDuration, findAgentTask, formatDuration, wasInterrupted } from "../../webview/src/agent-row"
import type { AgentsTaskInfo, ToolUpdate } from "../../webview/src/protocol"

// The shapes below are recorded from a 1.18.30 server running the
// oh-my-openagent plugin (keys and types kept, text shortened): a `task` call
// as it runs, once it has returned, once a stop closed it, and one that sent
// its agent to the background.
const running: ToolUpdate = {
  callID: "call_run",
  tool: "task",
  status: "running",
  input: { load_skills: ["frontend-ui-ux"], description: "Restyle the trace", prompt: "...", run_in_background: false, category: "visual-engineering", subagent_type: "", task_id: "", command: "" },
  time: { start: 1763696006000 },
}
const returned: ToolUpdate = {
  callID: "call_done",
  tool: "task",
  status: "completed",
  title: "Trace the abort path",
  input: { subagent_type: "oracle", run_in_background: false, load_skills: [], description: "Trace the abort path", prompt: "..." },
  output: "...",
  metadata: { truncated: false, prompt: "...", agent: "oracle", requested_subagent_type: "oracle", load_skills: [], description: "Trace the abort path", run_in_background: false, sessionId: "ses_child", model: { providerID: "anthropic", modelID: "claude-opus-4-7", variant: "max" } },
  time: { start: 1763696006000, end: 1763696047000 },
}
const stopped: ToolUpdate = {
  callID: "call_stop",
  tool: "task",
  status: "error",
  input: { load_skills: ["debugging"], description: "Check the reducer", prompt: "...", run_in_background: false, category: "", subagent_type: "explore", task_id: "", command: "" },
  error: "Tool execution aborted",
  metadata: { interrupted: true },
  time: { start: 1763696006000, end: 1763696037000 },
}
const launched: ToolUpdate = {
  callID: "call_bg",
  tool: "task",
  status: "completed",
  title: "Recheck visual quality",
  input: { subagent_type: "oracle", run_in_background: true, load_skills: [], description: "Recheck visual quality", prompt: "..." },
  output: "Background task launched.",
  metadata: { truncated: false, agent: "oracle", description: "Recheck visual quality", run_in_background: true, sessionId: "ses_bg", model: { providerID: "openai", modelID: "gpt-5.5", variant: "high" } },
  time: { start: 1763696006000, end: 1763696006200 },
}

const task = (over: Partial<AgentsTaskInfo>): AgentsTaskInfo => ({ id: "subagent:child:ses_x", kind: "subagent", title: "t", status: "running", startedAt: 0, updatedAt: 0, ...over })
const live = { live: true, stopped: false }
const over = { live: false, stopped: false }

describe("the state of a subagent's row (#796)", () => {
  it("follows the call: working, then done", () => {
    expect(agentState(running, undefined, live)).toBe("working")
    expect(agentState(returned, undefined, over)).toBe("done")
  })

  // A stop closes every running call as an error. Shown as one, each
  // subagent row turned red and a stop read as a failure.
  it("tells a stop from a failure", () => {
    expect(wasInterrupted(stopped)).toBe(true)
    expect(agentState(stopped, undefined, { live: false, stopped: true })).toBe("stopped")
    // The same closure, in a turn the user did not stop: the main agent dropped it.
    expect(agentState(stopped, undefined, over)).toBe("cancelled")
    expect(agentState({ ...returned, status: "error", error: "Model not found", metadata: {} }, undefined, over)).toBe("failed")
  })

  it("lets the live task say what the call cannot", () => {
    // Waiting on the user's answer.
    expect(agentState(running, task({ status: "waiting" }), live)).toBe("waiting")
    // Sent to the background: the call has returned, the agent has not.
    expect(agentState(launched, task({ status: "running" }), live)).toBe("working")
    // The background agent failed after its call returned.
    expect(agentState(launched, task({ status: "error", error: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." }), live)).toBe("failed")
  })

  it("counts a call nothing closed as stopped once the message is over", () => {
    expect(agentState(running, undefined, over)).toBe("stopped")
  })
})

describe("what a subagent's row shows (#796)", () => {
  it("names the agent's kind, and the category when the call named none", () => {
    expect(agentKind(returned)).toBe("oracle")
    expect(agentKind(running)).toBe("visual-engineering")
    expect(agentKind(running, "explore")).toBe("explore")
    expect(agentKind({ callID: "c", tool: "subagent", status: "running", input: { agent: "general" } })).toBe("general")
  })

  it("reads the model from the returned call, and from the task before that", () => {
    expect(agentModel(returned, undefined)).toBe("anthropic/claude-opus-4-7")
    expect(agentModel(running, task({ model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }))).toBe("anthropic/claude-sonnet-5-5")
  })

  it("times a finished agent from its call, but not one launched into the background", () => {
    expect(callDuration(returned)).toBe(41000)
    expect(callDuration(launched)).toBeUndefined()
    expect(callDuration(running)).toBeUndefined()
    expect([formatDuration(34_000), formatDuration(72_000), formatDuration(3_840_000)]).toEqual(["34s", "1m 12s", "1h 04m"])
  })

  it("finds the agent's task by its call, or by its session once its own calls arrive", () => {
    const tasks = [task({ id: "subagent:ses_p:call_run", callID: "call_run" }), task({ id: "subagent:child:ses_child" })]
    expect(findAgentTask(tasks, "call_run", undefined)).toBe(tasks[0])
    expect(findAgentTask(tasks, "call_other", "ses_child")).toBe(tasks[1])
    expect(findAgentTask(tasks, "call_other", undefined)).toBeUndefined()
  })

  it("sums up the agents at work for a folded block, and puts a request first", () => {
    expect(agentsNote([task({}), task({})])).toEqual({ text: "2 agents working", waiting: false })
    expect(agentsNote([task({}), task({ status: "waiting" })])).toEqual({ text: "1 agent needs approval", waiting: true })
    expect(agentsNote([task({ status: "error" })])).toBeUndefined()
  })
})
