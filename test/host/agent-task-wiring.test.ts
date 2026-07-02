import { describe, it, expect } from "vitest"
import {
  taskTitleFromUpdate,
  summarizeAgentTasks,
  isSubagentTool,
} from "../../src/agents/summary"
import { summarizePrompt } from "../../src/chat/subagent-dispatch"
import type { ToolUpdate } from "../../src/chat/stream"
import type { AgentTask } from "../../src/agents/task-store"

function makeUpdate(overrides: Partial<ToolUpdate> = {}): ToolUpdate {
  return {
    callID: "c1",
    tool: "task",
    status: "running",
    ...overrides,
  }
}

describe("taskTitleFromUpdate", () => {
  it("prefers input.description when it is a non-empty string", () => {
    expect(
      taskTitleFromUpdate(makeUpdate({ input: { description: "Fix TS errors" } })),
    ).toBe("Fix TS errors")
  })

  it("falls back to update.title when description is missing", () => {
    expect(taskTitleFromUpdate(makeUpdate({ title: "Hephaestus run" }))).toBe("Hephaestus run")
  })

  it("uses 'Background agent' as the last-resort title", () => {
    expect(taskTitleFromUpdate(makeUpdate({}))).toBe("Background agent")
  })

  it("ignores non-string description fields", () => {
    expect(taskTitleFromUpdate(makeUpdate({ input: { description: 5 } }))).toBe("Background agent")
  })

  it("trims whitespace-only descriptions", () => {
    expect(
      taskTitleFromUpdate(makeUpdate({ input: { description: "   " }, title: "Fallback" })),
    ).toBe("Fallback")
  })
})

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "main:c:s",
    kind: "main",
    conversationID: "c",
    sessionID: "s",
    title: "Main",
    status: "running",
    startedAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe("summarizeAgentTasks", () => {
  it("returns zeros for an empty list", () => {
    expect(summarizeAgentTasks([])).toEqual({
      running: 0,
      waiting: 0,
      error: 0,
      total: 0,
      tasks: [],
    })
  })

  it("counts running / waiting / error states", () => {
    const result = summarizeAgentTasks([
      task({ id: "a", status: "running" }),
      task({ id: "b", status: "running" }),
      task({ id: "c", status: "waiting" }),
      task({ id: "d", status: "error" }),
    ])
    expect(result.running).toBe(2)
    expect(result.waiting).toBe(1)
    expect(result.error).toBe(1)
    expect(result.total).toBe(4)
    expect(result.tasks.map((t) => t.id).sort()).toEqual(["a", "b", "c", "d"])
  })

  it("drops completed tasks — the popover shows only what's currently active", () => {
    const result = summarizeAgentTasks([
      task({ id: "a", status: "completed", startedAt: 1000, updatedAt: 5000 }),
    ])
    expect(result.tasks).toEqual([])
    expect(result.running).toBe(0)
    expect(result.total).toBe(0)
  })

  it("drops cancelled tasks (user-initiated aborts) and completed tasks", () => {
    const result = summarizeAgentTasks([
      task({ id: "a", status: "cancelled" }),
      task({ id: "b", status: "completed" }),
      task({ id: "c", status: "running" }),
    ])
    expect(result.tasks.map((t) => t.id)).toEqual(["c"])
  })

  it("filters by conversationID when provided", () => {
    const result = summarizeAgentTasks(
      [
        task({ id: "x", conversationID: "convA", status: "running" }),
        task({ id: "y", conversationID: "convB", status: "running" }),
        task({ id: "z", conversationID: "convA", kind: "subagent", status: "error" }),
      ],
      "convA",
    )
    expect(result.running).toBe(1)
    expect(result.error).toBe(1)
    expect(result.total).toBe(2)
    expect(result.tasks.map((t) => t.id)).toEqual(["x", "z"])
  })

  it("drops completed subagents even while the parent main task is still alive", () => {
    const result = summarizeAgentTasks([
      task({ id: "main:c:s", kind: "main", status: "running" }),
      task({ id: "subagent:s:c1", kind: "subagent", status: "completed", startedAt: 100 }),
      task({ id: "subagent:s:c2", kind: "subagent", status: "running", startedAt: 200 }),
    ])
    expect(result.running).toBe(2)
    expect(result.total).toBe(2)
    expect(result.tasks.map((t) => t.id)).toEqual(["main:c:s", "subagent:s:c2"])
  })

  it("empties the popover after every task settles — no per-chat history", () => {
    const result = summarizeAgentTasks([
      task({ id: "main:c:s", kind: "main", status: "completed", startedAt: 0, updatedAt: 9000 }),
      task({ id: "subagent:s:c1", kind: "subagent", status: "completed", startedAt: 100, updatedAt: 5000 }),
      task({ id: "subagent:s:c2", kind: "subagent", status: "completed", startedAt: 200, updatedAt: 7000 }),
    ])
    expect(result.tasks).toEqual([])
    expect(result.running).toBe(0)
    expect(result.total).toBe(0)
  })

  it("drops cancelled subagents — even when the parent is alive (user-initiated abort = noise)", () => {
    const result = summarizeAgentTasks([
      task({ id: "main:c:s", kind: "main", status: "running" }),
      task({ id: "subagent:s:c1", kind: "subagent", status: "cancelled" }),
    ])
    expect(result.tasks.map((t) => t.id)).toEqual(["main:c:s"])
  })

  it("orders Main first, then Subagents, both by startedAt ascending", () => {
    const result = summarizeAgentTasks([
      task({ id: "sub-late", kind: "subagent", status: "running", startedAt: 3000 }),
      task({ id: "sub-early", kind: "subagent", status: "running", startedAt: 2000 }),
      task({ id: "main", kind: "main", status: "running", startedAt: 5000 }),
    ])
    expect(result.tasks.map((t) => t.id)).toEqual(["main", "sub-early", "sub-late"])
  })

  it("strips host-only fields and keeps only the wire shape", () => {
    const result = summarizeAgentTasks([
      task({
        id: "a",
        kind: "main",
        title: "Refactor",
        status: "running",
        startedAt: 1000,
        updatedAt: 1500,
        error: undefined,
      }),
    ])
    expect(result.tasks[0]).toEqual({
      id: "a",
      kind: "main",
      title: "Refactor",
      status: "running",
      error: undefined,
      startedAt: 1000,
      updatedAt: 1500,
      subagent: undefined,
      category: undefined,
      model: undefined,
    })
  })

  it("forwards updatedAt so error rows can render a frozen total runtime", () => {
    const result = summarizeAgentTasks([
      task({ id: "a", status: "error", error: "boom", startedAt: 1000, updatedAt: 4500 }),
    ])
    expect(result.tasks[0]!.updatedAt).toBe(4500)
  })

  it("passes through subagent/category/model on subagent rows", () => {
    const result = summarizeAgentTasks([
      task({
        id: "main:c:s",
        kind: "main",
        sessionID: "s",
        status: "running",
      }),
      task({
        id: "subagent:child:ses_x",
        kind: "subagent",
        sessionID: "s",
        callID: "c1",
        childSessionID: "ses_x",
        subagent: "explore",
        category: "deep",
        model: { providerID: "github-copilot", modelID: "claude-opus-4.5" },
        runInBackground: true,
        status: "running",
      }),
    ])
    const subRow = result.tasks.find((t) => t.kind === "subagent")!
    expect(subRow.subagent).toBe("explore")
    expect(subRow.category).toBe("deep")
    expect(subRow.model).toEqual({ providerID: "github-copilot", modelID: "claude-opus-4.5" })
  })

  it("does NOT carry subagent metadata on main rows", () => {
    const result = summarizeAgentTasks([
      task({
        id: "main:c:s",
        kind: "main",
        sessionID: "s",
        status: "running",
        subagent: "hephaestus",
        model: { providerID: "github-copilot", modelID: "gpt-5.5" },
      }),
    ])
    const mainRow = result.tasks[0]!
    expect(mainRow.subagent).toBeUndefined()
    expect(mainRow.category).toBeUndefined()
    expect(mainRow.model).toBeUndefined()
  })
})

describe("isSubagentTool", () => {
  it("matches opencode's built-in `task` tool", () => {
    expect(isSubagentTool("task")).toBe(true)
  })

  it("matches omo's `call_omo_agent` used by Hephaestus / Sisyphus subagents", () => {
    expect(isSubagentTool("call_omo_agent")).toBe(true)
  })

  it("matches omo's `background_task` (Hephaestus fire-and-forget pattern)", () => {
    expect(isSubagentTool("background_task")).toBe(true)
  })

  it("matches `delegate_task` defensively (in case omo re-registers under its lowercase name)", () => {
    expect(isSubagentTool("delegate_task")).toBe(true)
  })

  it("matches defensive name variants (Task, task_tool)", () => {
    expect(isSubagentTool("Task")).toBe(true)
    expect(isSubagentTool("task_tool")).toBe(true)
  })

  it("returns false for non-subagent tools", () => {
    for (const name of ["read", "edit", "bash", "grep", "glob", "webfetch", "tasks", "callomoagent"]) {
      expect(isSubagentTool(name)).toBe(false)
    }
  })
})

describe("summarizePrompt", () => {
  it("collapses whitespace and caps at 64 characters", () => {
    const text = "  Fix   TypeScript    errors  in the build  "
    expect(summarizePrompt(text)).toBe("Fix TypeScript errors in the build")
  })

  it("truncates long prompts", () => {
    const text = "a".repeat(200)
    expect(summarizePrompt(text).length).toBe(64)
  })

  it("falls back to 'Main agent' when text is empty", () => {
    expect(summarizePrompt("")).toBe("Main agent")
    expect(summarizePrompt("   ")).toBe("Main agent")
  })
})
