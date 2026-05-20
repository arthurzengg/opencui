import { describe, it, expect } from "vitest"
import {
  taskTitleFromUpdate,
  summarizePrompt,
  summarizeAgentTasks,
  isSubagentTool,
} from "../../src/chat/view"
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

  it("ignores completed and cancelled tasks", () => {
    const result = summarizeAgentTasks([
      task({ id: "a", status: "completed" }),
      task({ id: "b", status: "cancelled" }),
    ])
    expect(result.tasks).toEqual([])
    expect(result.total).toBe(0)
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
    })
  })
})

describe("isSubagentTool", () => {
  it("matches opencode's built-in `task` tool", () => {
    expect(isSubagentTool("task")).toBe(true)
  })

  it("matches omo's `call_omo_agent` used by Hephaestus / Sisyphus subagents", () => {
    expect(isSubagentTool("call_omo_agent")).toBe(true)
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
