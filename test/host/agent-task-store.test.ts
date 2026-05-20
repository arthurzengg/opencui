import { describe, it, expect, beforeEach } from "vitest"
import {
  AGENT_TASKS_KEY,
  AgentTaskStore,
  mainTaskID,
  subagentTaskID,
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

  it("update is a no-op for unknown ids", async () => {
    const store = new AgentTaskStore(memento)
    let fires = 0
    store.onDidChange(() => (fires += 1))
    await store.update("missing", { status: "completed" })
    expect(fires).toBe(0)
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

  it("markSessionIdle completes still-running tasks for the session only", async () => {
    const store = new AgentTaskStore(memento)
    await store.upsert(fixedTask({ id: "main:c:s1", sessionID: "s1", status: "running" }))
    await store.upsert(fixedTask({ id: "subagent:s1:c1", kind: "subagent", sessionID: "s1", callID: "c1", status: "running" }))
    await store.upsert(fixedTask({ id: "main:c:s2", sessionID: "s2", status: "running" }))
    await store.markSessionIdle("s1", 5000)
    expect(store.get("main:c:s1")!.status).toBe("completed")
    expect(store.get("subagent:s1:c1")!.status).toBe("completed")
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
    expect(mainTaskID("c", "s")).toBe("main:c:s")
    expect(subagentTaskID("s", "call-1")).toBe("subagent:s:call-1")
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
