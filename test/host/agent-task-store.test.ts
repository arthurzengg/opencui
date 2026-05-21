import { describe, it, expect, beforeEach } from "vitest"
import {
  AGENT_TASKS_KEY,
  AgentTaskStore,
  classifyTerminal,
  mainTaskID,
  subagentTaskID,
  subagentTaskIDByChildSession,
  type AgentTask,
  type Memento,
} from "../../src/agents/task-store"

class FakeMemento implements Memento {
  private store: Record<string, unknown> = {}

  setSeed(key: string, value: unknown) {
    this.store[key] = JSON.parse(JSON.stringify(value))
  }

  get<T>(key: string): T | undefined
  get<T>(key: string, defaultValue: T): T
  get<T>(key: string, defaultValue?: T): T | undefined {
    const value = this.store[key]
    if (value === undefined) return defaultValue
    return value as T
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      delete this.store[key]
      return
    }
    this.store[key] = JSON.parse(JSON.stringify(value))
  }

  snapshot(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this.store))
  }
}

function fixedTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "main:conv:sess",
    kind: "main",
    conversationID: "conv",
    sessionID: "sess",
    title: "Main",
    status: "running",
    startedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe("AgentTaskStore", () => {
  let memento: FakeMemento

  beforeEach(() => {
    memento = new FakeMemento()
  })

  it("loads tasks from workspace state on construction", () => {
    const seed = [fixedTask(), fixedTask({ id: "subagent:sess:c1", kind: "subagent", callID: "c1" })]
    memento.setSeed(AGENT_TASKS_KEY, seed)
    const store = new AgentTaskStore(memento)
    expect(store.list().map((t) => t.id)).toEqual([
      "main:conv:sess",
      "subagent:sess:c1",
    ])
  })

  it("drops malformed entries while loading", () => {
    memento.setSeed(AGENT_TASKS_KEY, [
      fixedTask(),
      { id: 5, kind: "main", status: "running" },
      null,
      "garbage",
      { ...fixedTask(), kind: "bogus" },
    ])
    const store = new AgentTaskStore(memento)
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.kind).toBe("main")
  })

  it("upsert is idempotent for an unchanged task", async () => {
    const store = new AgentTaskStore(memento)
    let fires = 0
    store.onDidChange(() => (fires += 1))
    const task = fixedTask()
    await store.upsert(task)
    await store.upsert({ ...task })
    expect(fires).toBe(1)
    expect(store.list()).toHaveLength(1)
  })

  it("upsert preserves startedAt across mutations", async () => {
    const store = new AgentTaskStore(memento)
    await store.upsert(fixedTask({ startedAt: 1000, updatedAt: 1000 }))
    await store.upsert(fixedTask({ startedAt: 9999, updatedAt: 2000, status: "completed" }))
    const task = store.get("main:conv:sess")!
    expect(task.startedAt).toBe(1000)
    expect(task.status).toBe("completed")
    expect(task.updatedAt).toBe(2000)
  })

  it("running → completed updates status and persists", async () => {
    const store = new AgentTaskStore(memento)
    await store.upsert(fixedTask())
    await store.update("main:conv:sess", { status: "completed", updatedAt: 2000 })
    expect(store.get("main:conv:sess")!.status).toBe("completed")
    const persisted = memento.get<AgentTask[]>(AGENT_TASKS_KEY)
    expect(persisted?.[0]?.status).toBe("completed")
  })

  it("running → error keeps the task visible to active()", async () => {
    const store = new AgentTaskStore(memento)
    await store.upsert(fixedTask())
    await store.update("main:conv:sess", { status: "error", error: "boom" })
    const active = store.active()
    expect(active).toHaveLength(1)
    expect(active[0]!.error).toBe("boom")
  })

  it("active() excludes completed and cancelled tasks", async () => {
    const store = new AgentTaskStore(memento)
    await store.upsert(fixedTask({ id: "main:conv:s1", status: "running" }))
    await store.upsert(fixedTask({ id: "main:conv:s2", status: "completed", sessionID: "s2" }))
    await store.upsert(fixedTask({ id: "main:conv:s3", status: "cancelled", sessionID: "s3" }))
    await store.upsert(fixedTask({ id: "main:conv:s4", status: "error", sessionID: "s4" }))
    const ids = store.active().map((t) => t.id).sort()
    expect(ids).toEqual(["main:conv:s1", "main:conv:s4"])
  })

  it("once terminal, upsert cannot resurrect to running", async () => {
    const store = new AgentTaskStore(memento)
    await store.upsert(fixedTask({ status: "completed", updatedAt: 2000 }))
    let fires = 0
    store.onDidChange(() => (fires += 1))
    await store.upsert(fixedTask({ status: "running", updatedAt: 3000 }))
    expect(fires).toBe(0)
    expect(store.get("main:conv:sess")!.status).toBe("completed")
  })

  it("once cancelled, update cannot flip to error (preserves user-initiated Stop)", async () => {
    // Regression: a stray child `session.error` arriving after the user
    // aborted would have flipped the row from `cancelled` to `error`,
    // overriding the user's explicit Stop.
    const store = new AgentTaskStore(memento)
    await store.upsert(fixedTask({ status: "cancelled", updatedAt: 2000 }))
    let fires = 0
    store.onDidChange(() => (fires += 1))
    await store.update("main:conv:sess", { status: "error", error: "rate limit", updatedAt: 3000 })
    expect(fires).toBe(0)
    expect(store.get("main:conv:sess")!.status).toBe("cancelled")
    expect(store.get("main:conv:sess")!.error).toBeUndefined()
  })

  it("rejects every other terminal→other-terminal status flip", async () => {
    const store = new AgentTaskStore(memento)
    await store.upsert(fixedTask({ id: "a", status: "completed", updatedAt: 1000 }))
    await store.upsert(fixedTask({ id: "b", status: "error", updatedAt: 1000 }))
    await store.update("a", { status: "cancelled", updatedAt: 2000 })
    await store.update("a", { status: "error", error: "x", updatedAt: 2000 })
    await store.update("b", { status: "cancelled", updatedAt: 2000 })
    await store.update("b", { status: "completed", updatedAt: 2000 })
    expect(store.get("a")!.status).toBe("completed")
    expect(store.get("b")!.status).toBe("error")
  })

  it("allows metadata refresh on terminal rows when the patch omits status", async () => {
    // The strict guard only freezes `status` — other fields (model
    // backfill, error message refresh on same status) still apply so
    // late `assistantEnd` events can enrich settled rows.
    const store = new AgentTaskStore(memento)
    await store.upsert(
      fixedTask({
        id: "sub",
        kind: "subagent",
        status: "completed",
        startedAt: 1000,
        updatedAt: 2000,
      }),
    )
    await store.update("sub", {
      model: { providerID: "github-copilot", modelID: "claude-opus-4.5" },
      updatedAt: 3000,
    })
    expect(store.get("sub")!.status).toBe("completed")
    expect(store.get("sub")!.model).toEqual({
      providerID: "github-copilot",
      modelID: "claude-opus-4.5",
    })
  })

  it("update is a no-op for unknown ids", async () => {
    const store = new AgentTaskStore(memento)
    let fires = 0
    store.onDidChange(() => (fires += 1))
    await store.update("missing", { status: "completed" })
    expect(fires).toBe(0)
  })

  it("clearForConversation drops every task — live or historical — for that conversation only", async () => {
    const store = new AgentTaskStore(memento)
    await store.upsert(fixedTask({ id: "main:c1:s1", conversationID: "c1", sessionID: "s1", status: "running" }))
    await store.upsert(
      fixedTask({
        id: "subagent:c1:done",
        conversationID: "c1",
        sessionID: "s1",
        kind: "subagent",
        callID: "x",
        status: "completed",
      }),
    )
    await store.upsert(fixedTask({ id: "main:c2:s2", conversationID: "c2", sessionID: "s2", status: "running" }))
    await store.clearForConversation("c1")
    expect(store.list().map((t) => t.id)).toEqual(["main:c2:s2"])
  })

  it("clearCompleted drops completed/cancelled but keeps running/error", async () => {
    const store = new AgentTaskStore(memento)
    await store.upsert(fixedTask({ id: "a", status: "running" }))
    await store.upsert(fixedTask({ id: "b", status: "completed" }))
    await store.upsert(fixedTask({ id: "c", status: "cancelled" }))
    await store.upsert(fixedTask({ id: "d", status: "error" }))
    await store.clearCompleted()
    expect(store.list().map((t) => t.id).sort()).toEqual(["a", "d"])
  })

  it("markSessionIdle completes only the MAIN task — subagents are owned by SubagentTracker", async () => {
    const store = new AgentTaskStore(memento)
    await store.upsert(fixedTask({ id: "main:c:s1", sessionID: "s1", status: "running" }))
    await store.upsert(
      fixedTask({ id: "subagent:s1:c1", kind: "subagent", sessionID: "s1", callID: "c1", status: "running" }),
    )
    await store.upsert(fixedTask({ id: "main:c:s2", sessionID: "s2", status: "running" }))
    await store.markSessionIdle("s1", 5000)
    expect(store.get("main:c:s1")!.status).toBe("completed")
    // Subagents must NOT be auto-completed when the parent goes idle:
    // omo's `run_in_background=true` subagents keep working long after
    // the parent's last assistant message lands. The child session's
    // own idle event (routed via SubagentTracker) settles them.
    expect(store.get("subagent:s1:c1")!.status).toBe("running")
    expect(store.get("main:c:s2")!.status).toBe("running")
  })

  it("cancelSessionTasks settles every active task for the session (used by user-initiated abort)", async () => {
    const store = new AgentTaskStore(memento)
    await store.upsert(fixedTask({ id: "main:c:s1", sessionID: "s1", status: "running" }))
    await store.upsert(
      fixedTask({ id: "subagent:s1:c1", kind: "subagent", sessionID: "s1", callID: "c1", status: "running" }),
    )
    await store.upsert(fixedTask({ id: "main:c:s2", sessionID: "s2", status: "running" }))
    await store.cancelSessionTasks("s1", 5000)
    expect(store.get("main:c:s1")!.status).toBe("cancelled")
    expect(store.get("subagent:s1:c1")!.status).toBe("cancelled")
    expect(store.get("main:c:s2")!.status).toBe("running")
  })

  it("fires onDidChange exactly once per mutation", async () => {
    const store = new AgentTaskStore(memento)
    const snapshots: AgentTask[][] = []
    store.onDidChange((tasks) => snapshots.push(tasks))
    await store.upsert(fixedTask())
    await store.update("main:conv:sess", { status: "completed", updatedAt: 2000 })
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]!.length).toBe(1)
    expect(snapshots[1]!.length).toBe(1)
    expect(snapshots[1]![0]!.status).toBe("completed")
  })

  it("exposes stable id helpers", () => {
    expect(mainTaskID("c", "s", "turn-1")).toBe("main:c:s:turn-1")
    expect(subagentTaskID("s", "call-1")).toBe("subagent:s:call-1")
    expect(subagentTaskIDByChildSession("ses_child_1")).toBe("subagent:child:ses_child_1")
  })

  it("main tasks are keyed per turn: a follow-up message creates a new row, prior row stays completed", async () => {
    // Simulates two sequential user prompts in the same conversation /
    // session. Each turn gets its own main task ID (ChatView mints a
    // fresh turnID at recordMainTaskStart) so the popover shows BOTH
    // rows — the prior one as completed history, the new one as live.
    const store = new AgentTaskStore(memento)
    const turn1 = mainTaskID("c", "s", "turn-1")
    const turn2 = mainTaskID("c", "s", "turn-2")
    await store.upsert(
      fixedTask({ id: turn1, conversationID: "c", sessionID: "s", status: "running", startedAt: 1000, updatedAt: 1000 }),
    )
    await store.markSessionIdle("s", 2000)
    expect(store.get(turn1)!.status).toBe("completed")
    await store.upsert(
      fixedTask({ id: turn2, conversationID: "c", sessionID: "s", status: "running", startedAt: 3000, updatedAt: 3000 }),
    )
    expect(store.get(turn1)!.status).toBe("completed")
    expect(store.get(turn2)!.status).toBe("running")
    expect(store.list().map((t) => t.id)).toEqual([turn1, turn2])
  })

  it("getByChildSession looks up a subagent by its child opencode sessionID", async () => {
    const store = new AgentTaskStore(memento)
    await store.upsert(
      fixedTask({
        id: subagentTaskIDByChildSession("ses_child_42"),
        kind: "subagent",
        sessionID: "ses_parent",
        callID: "c1",
        childSessionID: "ses_child_42",
      }),
    )
    const found = store.getByChildSession("ses_child_42")
    expect(found?.id).toBe("subagent:child:ses_child_42")
    expect(store.getByChildSession("ses_missing")).toBeUndefined()
  })

  it("activeSubagentsForSession scopes by parent session and active status", async () => {
    const store = new AgentTaskStore(memento)
    await store.upsert(fixedTask({ id: "main:c:s1", kind: "main", sessionID: "s1" }))
    await store.upsert(
      fixedTask({
        id: "subagent:child:a",
        kind: "subagent",
        sessionID: "s1",
        childSessionID: "a",
        status: "running",
      }),
    )
    await store.upsert(
      fixedTask({
        id: "subagent:child:b",
        kind: "subagent",
        sessionID: "s1",
        childSessionID: "b",
        status: "completed",
      }),
    )
    await store.upsert(
      fixedTask({
        id: "subagent:child:c",
        kind: "subagent",
        sessionID: "s2",
        childSessionID: "c",
        status: "running",
      }),
    )
    const active = store.activeSubagentsForSession("s1")
    expect(active.map((t) => t.id)).toEqual(["subagent:child:a"])
    expect(store.hasActiveSubagentsForSession("s1")).toBe(true)
    expect(store.hasActiveSubagentsForSession("s_unknown")).toBe(false)
  })

  it("round-trips the new metadata fields (childSessionID, model, subagent, category, runInBackground)", async () => {
    const seed: AgentTask = {
      ...fixedTask({
        id: "subagent:child:ses_x",
        kind: "subagent",
        callID: "c1",
        sessionID: "ses_parent",
      }),
      childSessionID: "ses_x",
      backgroundTaskID: "bg_42",
      subagent: "explore",
      category: "deep",
      model: { providerID: "github-copilot", modelID: "claude-opus-4.5" },
      runInBackground: true,
    }
    memento.setSeed(AGENT_TASKS_KEY, [seed])
    const store = new AgentTaskStore(memento)
    const got = store.get("subagent:child:ses_x")!
    expect(got.childSessionID).toBe("ses_x")
    expect(got.backgroundTaskID).toBe("bg_42")
    expect(got.subagent).toBe("explore")
    expect(got.category).toBe("deep")
    expect(got.model).toEqual({ providerID: "github-copilot", modelID: "claude-opus-4.5" })
    expect(got.runInBackground).toBe(true)
  })

  it("hasActive / hasRunning distinguish running vs error", async () => {
    const store = new AgentTaskStore(memento)
    expect(store.hasActive()).toBe(false)
    expect(store.hasRunning()).toBe(false)
    await store.upsert(fixedTask({ id: "a", status: "error" }))
    expect(store.hasActive()).toBe(true)
    expect(store.hasRunning()).toBe(false)
    await store.upsert(fixedTask({ id: "b", status: "running" }))
    expect(store.hasRunning()).toBe(true)
  })
})

describe("classifyTerminal", () => {
  it("maps the literal 'Aborted' message to cancelled with no error string", () => {
    expect(classifyTerminal("Aborted")).toEqual({ status: "cancelled" })
  })

  it("matches case-insensitively and tolerates surrounding whitespace", () => {
    expect(classifyTerminal("aborted")).toEqual({ status: "cancelled" })
    expect(classifyTerminal("ABORTED")).toEqual({ status: "cancelled" })
    expect(classifyTerminal("  Aborted  ")).toEqual({ status: "cancelled" })
  })

  it("keeps real failure messages as error and preserves the message", () => {
    expect(classifyTerminal("rate limit exceeded")).toEqual({
      status: "error",
      error: "rate limit exceeded",
    })
    expect(classifyTerminal("Aborted: rate limit")).toEqual({
      status: "error",
      error: "Aborted: rate limit",
    })
  })

  it("treats an undefined message as error with no body", () => {
    expect(classifyTerminal(undefined)).toEqual({ status: "error", error: undefined })
  })
})
