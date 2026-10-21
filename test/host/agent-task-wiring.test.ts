import { describe, it, expect } from "vitest"
import {
  taskTitleFromUpdate,
  summarizeAgentTasks,
  isSubagentTool,
  compactSessionMessages,
  MAX_ACTIVITY_TEXT_CHARS,
  MAX_ACTIVITY_TOOLS,
} from "../../src/agents/summary"
import { SubagentDispatch, summarizePrompt } from "../../src/chat/subagent-dispatch"
import type { ToolUpdate } from "../../src/chat/stream"
import { AgentTaskStore, type AgentTask, type Memento } from "../../src/agents/task-store"

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

  it("keeps total === tasks.length and total === running + waiting + error", () => {
    // AgentActivity renders nothing at total 0 and renders the popover rows
    // unconditionally past that guard — both rely on these two identities.
    const result = summarizeAgentTasks([
      task({ id: "a", status: "running" }),
      task({ id: "b", status: "waiting" }),
      task({ id: "c", status: "error" }),
      task({ id: "d", status: "completed" }),
      task({ id: "e", status: "cancelled" }),
    ])
    expect(result.total).toBe(result.tasks.length)
    expect(result.total).toBe(result.running + result.waiting + result.error)
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
      childSessionID: undefined,
    })
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

  it("forwards childSessionID so the webview can request the child transcript", () => {
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
        childSessionID: "ses_x",
        status: "running",
      }),
    ])
    const mainRow = result.tasks.find((t) => t.kind === "main")!
    const subRow = result.tasks.find((t) => t.kind === "subagent")!
    expect(mainRow.childSessionID).toBeUndefined()
    expect(subRow.childSessionID).toBe("ses_x")
    // sessionID itself must stay stripped — privacy strip unchanged.
    expect(Object.keys(mainRow)).not.toContain("sessionID")
    expect(Object.keys(mainRow)).not.toContain("conversationID")
    expect(Object.keys(mainRow)).not.toContain("callID")
  })
})

describe("compactSessionMessages", () => {
  it("reduces a transcript to role + joined text + tool names", () => {
    const out = compactSessionMessages([
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "do the thing" }] },
      {
        info: { id: "m2", role: "assistant" },
        parts: [
          { type: "reasoning", text: "hidden chain" },
          { type: "tool", tool: "bash", callID: "c1", state: { status: "running" } },
          { type: "text", text: "part one" },
          { type: "text", text: "part two" },
        ],
      },
    ])
    expect(out).toEqual([
      { role: "user", text: "do the thing", tools: [] },
      { role: "assistant", text: "part one\n\npart two", tools: ["bash"] },
    ])
  })

  it("keeps running tools (stuck mid-tool is the point of the view)", () => {
    const out = compactSessionMessages([
      {
        info: { id: "m1", role: "assistant" },
        parts: [{ type: "tool", tool: "task", callID: "c1", state: { status: "running" } }],
      },
    ])
    expect(out).toEqual([{ role: "assistant", text: "", tools: ["task"] }])
  })

  it("skips synthetic/ignored text and non-user/assistant roles", () => {
    const out = compactSessionMessages([
      { info: { id: "m0", role: "system" }, parts: [{ type: "text", text: "sys" }] },
      {
        info: { id: "m2", role: "user" },
        parts: [
          { type: "text", text: "synthetic", synthetic: true },
          { type: "text", text: "ignored", ignored: true },
        ],
      },
      { info: { id: "m3", role: "assistant" }, parts: [{ type: "reasoning", text: "only reasoning" }] },
    ])
    expect(out).toEqual([])
  })

  it("keeps summary messages — they are assistant text and cheap context", () => {
    const out = compactSessionMessages([
      { info: { id: "m1", role: "assistant", summary: true }, parts: [{ type: "text", text: "sum" }] },
    ])
    expect(out).toEqual([{ role: "assistant", text: "sum", tools: [] }])
  })

  it("caps text at MAX_ACTIVITY_TEXT_CHARS and tools at MAX_ACTIVITY_TOOLS", () => {
    const out = compactSessionMessages([
      {
        info: { id: "m1", role: "assistant" },
        parts: [
          { type: "text", text: "x".repeat(MAX_ACTIVITY_TEXT_CHARS + 500) },
          ...Array.from({ length: MAX_ACTIVITY_TOOLS + 20 }, (_, i) => ({
            type: "tool",
            tool: `tool_${i}`,
            callID: `c${i}`,
            state: { status: "running" },
          })),
        ],
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toHaveLength(MAX_ACTIVITY_TEXT_CHARS)
    expect(out[0]!.tools).toHaveLength(MAX_ACTIVITY_TOOLS)
  })

  it("drops messages with neither text nor tools", () => {
    const out = compactSessionMessages([
      { info: { id: "m1", role: "assistant" }, parts: [] },
      { info: { id: "m2", role: "assistant" } },
    ])
    expect(out).toEqual([])
  })
})

describe("isSubagentTool", () => {
  it("matches opencode's built-in `task` tool", () => {
    expect(isSubagentTool("task")).toBe(true)
  })

  it("matches opencode 2.0's built-in `subagent` tool", () => {
    expect(isSubagentTool("subagent")).toBe(true)
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

describe("SubagentDispatch.setMainWaiting", () => {
  function makeDispatch() {
    const backing = new Map<string, unknown>()
    const memento = {
      get: (key: string, defaultValue?: unknown) =>
        backing.has(key) ? backing.get(key) : defaultValue,
      update: async (key: string, value: unknown) => {
        backing.set(key, value)
      },
    }
    const store = new AgentTaskStore(memento as unknown as Memento)
    const dispatch = new SubagentDispatch({
      taskStore: store,
      getSessionID: () => "sess_1",
      getActiveConversationID: () => "conv_1",
      collapseToGraceIfSettled: () => {},
    })
    return { store, dispatch }
  }

  it("flips the current Main row running -> waiting -> running", async () => {
    const { store, dispatch } = makeDispatch()
    await dispatch.recordMainTaskStart("guarded work")
    await dispatch.setMainWaiting(true)
    expect(store.list()[0]!.status).toBe("waiting")
    await dispatch.setMainWaiting(false)
    expect(store.list()[0]!.status).toBe("running")
  })

  it("is idempotent in both directions", async () => {
    const { store, dispatch } = makeDispatch()
    await dispatch.recordMainTaskStart("x")
    await dispatch.setMainWaiting(false)
    expect(store.list()[0]!.status).toBe("running")
    await dispatch.setMainWaiting(true)
    await dispatch.setMainWaiting(true)
    expect(store.list()[0]!.status).toBe("waiting")
  })

  it("still settles a waiting row on finish", async () => {
    const { store, dispatch } = makeDispatch()
    await dispatch.recordMainTaskStart("x")
    await dispatch.setMainWaiting(true)
    await dispatch.recordMainTaskFinish("completed")
    expect(store.list()[0]!.status).toBe("completed")
  })

  it("never touches a settled row (stray sync after finish)", async () => {
    const { store, dispatch } = makeDispatch()
    await dispatch.recordMainTaskStart("x")
    await dispatch.recordMainTaskFinish("completed")
    await dispatch.setMainWaiting(true)
    expect(store.list()[0]!.status).toBe("completed")
  })

  it("no-ops when no turn is in flight", async () => {
    const { store, dispatch } = makeDispatch()
    await dispatch.setMainWaiting(true)
    expect(store.list()).toHaveLength(0)
  })
})
