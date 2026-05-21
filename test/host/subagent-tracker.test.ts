import { describe, it, expect, beforeEach } from "vitest"
import {
  SubagentTracker,
  readMetadata,
  type SubagentSubscription,
} from "../../src/agents/subagent-tracker"
import {
  AgentTaskStore,
  subagentTaskID,
  subagentTaskIDByChildSession,
  type AgentTask,
  type Memento,
} from "../../src/agents/task-store"
import type { ToolUpdate } from "../../src/chat/stream"

class FakeMemento implements Memento {
  private store: Record<string, unknown> = {}
  get<T>(key: string): T | undefined
  get<T>(key: string, def: T): T
  get<T>(key: string, def?: T): T | undefined {
    const v = this.store[key]
    return v === undefined ? def : (v as T)
  }
  async update(key: string, value: unknown) {
    if (value === undefined) delete this.store[key]
    else this.store[key] = JSON.parse(JSON.stringify(value))
  }
}

class FakeSubscription implements SubagentSubscription {
  added: string[] = []
  removed: string[] = []
  addChildSession(id: string) {
    this.added.push(id)
  }
  removeChildSession(id: string) {
    this.removed.push(id)
  }
}

function makeUpdate(overrides: Partial<ToolUpdate> = {}): ToolUpdate {
  return {
    callID: "c1",
    tool: "task",
    status: "running",
    ...overrides,
  }
}

function setupTracker(opts?: { sessionID?: string; conversationID?: string }) {
  const memento = new FakeMemento()
  const store = new AgentTaskStore(memento)
  const subscription = new FakeSubscription()
  const tracker = new SubagentTracker({
    store,
    getActiveConversationID: () => opts?.conversationID ?? "conv1",
    getParentSessionID: () => opts?.sessionID ?? "ses_parent",
    subscription,
  })
  return { tracker, store, subscription }
}

describe("readMetadata", () => {
  it("returns an empty object when metadata is undefined", () => {
    expect(readMetadata(undefined)).toEqual({})
  })

  it("extracts omo's standard payload (camelCase sessionId/taskId/backgroundTaskId)", () => {
    const meta = readMetadata({
      sessionId: "ses_child_1",
      taskId: "ses_child_1",
      backgroundTaskId: "bg_42",
      agent: "explore",
      category: "deep",
      run_in_background: true,
      model: { providerID: "github-copilot", modelID: "claude-opus-4.5" },
      description: "Find auth patterns",
    })
    expect(meta.childSessionID).toBe("ses_child_1")
    expect(meta.backgroundTaskID).toBe("bg_42")
    expect(meta.subagent).toBe("explore")
    expect(meta.category).toBe("deep")
    expect(meta.runInBackground).toBe(true)
    expect(meta.model).toEqual({ providerID: "github-copilot", modelID: "claude-opus-4.5" })
    expect(meta.description).toBe("Find auth patterns")
  })

  it("accepts snake_case fallbacks for forward-compat with future omo renames", () => {
    const meta = readMetadata({
      session_id: "ses_x",
      background_task_id: "bg_x",
      subagent_type: "librarian",
      model: { provider_id: "openai", model_id: "gpt-5.5" },
    })
    expect(meta.childSessionID).toBe("ses_x")
    expect(meta.backgroundTaskID).toBe("bg_x")
    expect(meta.subagent).toBe("librarian")
    expect(meta.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" })
  })

  it("ignores empty/whitespace string fields", () => {
    const meta = readMetadata({ sessionId: "   ", agent: "", category: "  " })
    expect(meta.childSessionID).toBeUndefined()
    expect(meta.subagent).toBeUndefined()
    expect(meta.category).toBeUndefined()
  })

  it("returns no model when either providerID or modelID is missing", () => {
    expect(readMetadata({ model: { providerID: "x" } }).model).toBeUndefined()
    expect(readMetadata({ model: { modelID: "y" } }).model).toBeUndefined()
  })
})

describe("SubagentTracker.handleToolUpdate", () => {
  it("creates a callID-keyed task on first running event when no metadata is present yet", async () => {
    const { tracker, store, subscription } = setupTracker()
    await tracker.handleToolUpdate(makeUpdate({ callID: "c1", status: "running" }), "msg_1")
    const task = store.get(subagentTaskID("ses_parent", "c1"))!
    expect(task).toBeDefined()
    expect(task.kind).toBe("subagent")
    expect(task.status).toBe("running")
    expect(task.childSessionID).toBeUndefined()
    expect(subscription.added).toEqual([])
  })

  it("promotes to child-session identity once metadata.sessionId arrives", async () => {
    const { tracker, store, subscription } = setupTracker()
    await tracker.handleToolUpdate(makeUpdate({ callID: "c1", status: "running" }))
    await tracker.handleToolUpdate(
      makeUpdate({
        callID: "c1",
        status: "running",
        metadata: {
          sessionId: "ses_child_1",
          backgroundTaskId: "bg_1",
          agent: "explore",
          model: { providerID: "github-copilot", modelID: "claude-opus-4.5" },
          run_in_background: true,
        },
      }),
    )
    expect(store.get(subagentTaskID("ses_parent", "c1"))).toBeUndefined()
    const promoted = store.get(subagentTaskIDByChildSession("ses_child_1"))!
    expect(promoted.childSessionID).toBe("ses_child_1")
    expect(promoted.backgroundTaskID).toBe("bg_1")
    expect(promoted.subagent).toBe("explore")
    expect(promoted.model).toEqual({ providerID: "github-copilot", modelID: "claude-opus-4.5" })
    expect(promoted.runInBackground).toBe(true)
    expect(subscription.added).toContain("ses_child_1")
  })

  it("preserves startedAt across promotion (no clock reset)", async () => {
    const { tracker, store } = setupTracker()
    await tracker.handleToolUpdate(makeUpdate({ callID: "c1", status: "running" }))
    const initial = store.get(subagentTaskID("ses_parent", "c1"))!
    await new Promise((r) => setTimeout(r, 10))
    await tracker.handleToolUpdate(
      makeUpdate({
        callID: "c1",
        status: "running",
        metadata: { sessionId: "ses_child_1" },
      }),
    )
    const promoted = store.get(subagentTaskIDByChildSession("ses_child_1"))!
    expect(promoted.startedAt).toBe(initial.startedAt)
  })

  it("IGNORES parent's terminal status when a child session is known (background dispatch)", async () => {
    const { tracker, store } = setupTracker()
    await tracker.handleToolUpdate(
      makeUpdate({
        callID: "c1",
        status: "running",
        metadata: { sessionId: "ses_child_1", run_in_background: true },
      }),
    )
    await tracker.handleToolUpdate(
      makeUpdate({
        callID: "c1",
        status: "completed",
        metadata: { sessionId: "ses_child_1", run_in_background: true },
      }),
    )
    // Background dispatch returns task_id quickly; the parent's tool
    // part going completed must NOT settle the subagent — the child is
    // still working in the background.
    expect(store.get(subagentTaskIDByChildSession("ses_child_1"))!.status).toBe("running")
  })

  it("HONORS parent's terminal status for FOREGROUND call_omo_agent even when a child session is known", async () => {
    // Regression: Hephaestus dispatched Sisyphus via `call_omo_agent`
    // (foreground), tool.completed arrived with the subagent's result,
    // but our gate ignored the parent terminal — subagent stuck on
    // "running" forever, blocking continuation defer indefinitely.
    const { tracker, store, subscription } = setupTracker()
    await tracker.handleToolUpdate(
      makeUpdate({
        tool: "call_omo_agent",
        callID: "c1",
        status: "running",
        metadata: { sessionId: "ses_child_1", agent: "Sisyphus", category: "quick" },
      }),
    )
    expect(subscription.added).toContain("ses_child_1")
    await tracker.handleToolUpdate(
      makeUpdate({
        tool: "call_omo_agent",
        callID: "c1",
        status: "completed",
        metadata: { sessionId: "ses_child_1", agent: "Sisyphus", category: "quick" },
      }),
    )
    expect(store.get(subagentTaskIDByChildSession("ses_child_1"))!.status).toBe("completed")
    // Subscription cleanup: late child events would otherwise reopen the row.
    expect(subscription.removed).toContain("ses_child_1")
  })

  it("HONORS parent's terminal status when run_in_background is explicitly false", async () => {
    const { tracker, store } = setupTracker()
    await tracker.handleToolUpdate(
      makeUpdate({
        callID: "c1",
        status: "running",
        metadata: { sessionId: "ses_child_2", run_in_background: false },
      }),
    )
    await tracker.handleToolUpdate(
      makeUpdate({
        callID: "c1",
        status: "completed",
        metadata: { sessionId: "ses_child_2", run_in_background: false },
      }),
    )
    expect(store.get(subagentTaskIDByChildSession("ses_child_2"))!.status).toBe("completed")
  })

  it("treats the `background_task` tool as background even when no run_in_background metadata is set", async () => {
    // background_task is omo's pure background dispatcher — always
    // background by name, regardless of metadata. Parent's tool.completed
    // returns the task_id immediately while the child keeps working.
    const { tracker, store } = setupTracker()
    await tracker.handleToolUpdate(
      makeUpdate({
        tool: "background_task",
        callID: "c1",
        status: "running",
        metadata: { sessionId: "ses_child_bg" },
      }),
    )
    await tracker.handleToolUpdate(
      makeUpdate({
        tool: "background_task",
        callID: "c1",
        status: "completed",
        metadata: { sessionId: "ses_child_bg" },
      }),
    )
    expect(store.get(subagentTaskIDByChildSession("ses_child_bg"))!.status).toBe("running")
  })

  it("HONORS parent's terminal status when no child session was ever known", async () => {
    const { tracker, store } = setupTracker()
    await tracker.handleToolUpdate(makeUpdate({ callID: "c1", status: "running" }))
    await tracker.handleToolUpdate(makeUpdate({ callID: "c1", status: "completed" }))
    // No metadata ever arrived — fall back to legacy behavior so opencode
    // without omo (or third-party tools that don't publish metadata)
    // still see their subagents complete.
    expect(store.get(subagentTaskID("ses_parent", "c1"))!.status).toBe("completed")
  })

  it("HONORS parent error when no child session known and copies the error message", async () => {
    const { tracker, store } = setupTracker()
    await tracker.handleToolUpdate(makeUpdate({ callID: "c1", status: "running" }))
    await tracker.handleToolUpdate(
      makeUpdate({ callID: "c1", status: "error", error: "permission denied" }),
    )
    const task = store.get(subagentTaskID("ses_parent", "c1"))!
    expect(task.status).toBe("error")
    expect(task.error).toBe("permission denied")
  })

  it("maps an Aborted parent error to cancelled so the popover doesn't flash red on an internal abort", async () => {
    const { tracker, store } = setupTracker()
    await tracker.handleToolUpdate(makeUpdate({ callID: "c1", status: "running" }))
    await tracker.handleToolUpdate(
      makeUpdate({ callID: "c1", status: "error", error: "Aborted" }),
    )
    const task = store.get(subagentTaskID("ses_parent", "c1"))!
    expect(task.status).toBe("cancelled")
    expect(task.error).toBeUndefined()
  })

  it("merges task_id reuse into a single row instead of accumulating dupes", async () => {
    const { tracker, store, subscription } = setupTracker()
    // First dispatch — Hephaestus's background-resume pattern: tool flips
    // to completed quickly while the child keeps working, then the child
    // emits idle when actually finished.
    await tracker.handleToolUpdate(
      makeUpdate({
        callID: "c1",
        status: "running",
        metadata: { sessionId: "ses_child_x", run_in_background: true },
      }),
    )
    await tracker.handleToolUpdate(
      makeUpdate({
        callID: "c1",
        status: "completed",
        metadata: { sessionId: "ses_child_x", run_in_background: true },
      }),
    )
    // Background dispatch: parent terminal is ignored; the child's own
    // idle is what settles the task.
    await tracker.handleChildSessionEvent({ type: "idle", sessionID: "ses_child_x" })
    expect(store.get(subagentTaskIDByChildSession("ses_child_x"))!.status).toBe("completed")
    // Second dispatch reuses task_id (Hephaestus pattern) under a NEW callID.
    await tracker.handleToolUpdate(
      makeUpdate({
        callID: "c2",
        status: "running",
        metadata: { sessionId: "ses_child_x", run_in_background: true },
      }),
    )
    // Same canonical id; the previous completion is *not* resurrected
    // (terminal status sticks per AgentTaskStore guard), so we end up
    // with at most one row per child session. The terminal guard means
    // the row remains `completed` — which is acceptable: it means we
    // tracked the resume but stopped counting it as active. The far
    // worse failure mode was N ghost duplicates per resume.
    const childTasks = store.list().filter((t) => t.childSessionID === "ses_child_x")
    expect(childTasks).toHaveLength(1)
    expect(subscription.added.filter((s) => s === "ses_child_x").length).toBeGreaterThanOrEqual(1)
  })
})

describe("SubagentTracker.handleChildSessionEvent", () => {
  async function bootstrapPromoted(sessionID = "ses_parent") {
    const { tracker, store, subscription } = setupTracker({ sessionID })
    await tracker.handleToolUpdate(
      makeUpdate({
        callID: "c1",
        status: "running",
        metadata: {
          sessionId: "ses_child_1",
          agent: "oracle",
          run_in_background: false,
        },
      }),
    )
    return { tracker, store, subscription }
  }

  it("a child `idle` event marks the subagent completed and unregisters the session", async () => {
    const { tracker, store, subscription } = await bootstrapPromoted()
    await tracker.handleChildSessionEvent({ type: "idle", sessionID: "ses_child_1" })
    expect(store.get(subagentTaskIDByChildSession("ses_child_1"))!.status).toBe("completed")
    expect(subscription.removed).toContain("ses_child_1")
  })

  it("a child `error` event marks the subagent errored with the message preserved", async () => {
    const { tracker, store, subscription } = await bootstrapPromoted()
    await tracker.handleChildSessionEvent({
      type: "error",
      sessionID: "ses_child_1",
      message: "rate limit exceeded",
    })
    const task = store.get(subagentTaskIDByChildSession("ses_child_1"))!
    expect(task.status).toBe("error")
    expect(task.error).toBe("rate limit exceeded")
    expect(subscription.removed).toContain("ses_child_1")
  })

  it("a child `error` event with message 'Aborted' maps to cancelled, not error", async () => {
    const { tracker, store, subscription } = await bootstrapPromoted()
    await tracker.handleChildSessionEvent({
      type: "error",
      sessionID: "ses_child_1",
      message: "Aborted",
    })
    const task = store.get(subagentTaskIDByChildSession("ses_child_1"))!
    expect(task.status).toBe("cancelled")
    expect(task.error).toBeUndefined()
    expect(subscription.removed).toContain("ses_child_1")
  })

  it("a child `assistantEnd` carrying an 'Aborted' error also maps to cancelled", async () => {
    const { tracker, store, subscription } = await bootstrapPromoted()
    await tracker.handleChildSessionEvent({
      type: "assistantEnd",
      sessionID: "ses_child_1",
      messageID: "msg_1",
      error: "Aborted",
    })
    const task = store.get(subagentTaskIDByChildSession("ses_child_1"))!
    expect(task.status).toBe("cancelled")
    expect(task.error).toBeUndefined()
    expect(subscription.removed).toContain("ses_child_1")
  })

  it("a child `busy` event keeps an active task on running but never resurrects a terminal one", async () => {
    const { tracker, store } = await bootstrapPromoted()
    await tracker.handleChildSessionEvent({ type: "idle", sessionID: "ses_child_1" })
    // Stray late busy event after settlement — must NOT bounce status back.
    await tracker.handleChildSessionEvent({ type: "busy", sessionID: "ses_child_1" })
    expect(store.get(subagentTaskIDByChildSession("ses_child_1"))!.status).toBe("completed")
  })

  it("an `assistantEnd` event backfills the model when omo metadata didn't carry one", async () => {
    const { tracker, store, subscription } = setupTracker()
    // Dispatch without model in metadata.
    await tracker.handleToolUpdate(
      makeUpdate({
        callID: "c1",
        status: "running",
        metadata: { sessionId: "ses_child_x", agent: "oracle" },
      }),
    )
    expect(store.get(subagentTaskIDByChildSession("ses_child_x"))!.model).toBeUndefined()
    await tracker.handleChildSessionEvent({
      type: "assistantEnd",
      sessionID: "ses_child_x",
      messageID: "msg_1",
      usage: { model: "github-copilot/claude-opus-4.5" },
    })
    expect(store.get(subagentTaskIDByChildSession("ses_child_x"))!.model).toEqual({
      providerID: "github-copilot",
      modelID: "claude-opus-4.5",
    })
    expect(subscription.removed).not.toContain("ses_child_x")
  })

  it("drops the event silently when no AgentTask exists for that child session", async () => {
    const { tracker, store } = setupTracker()
    await tracker.handleChildSessionEvent({ type: "idle", sessionID: "ses_ghost" })
    expect(store.list()).toEqual([])
  })
})

describe("SubagentTracker.reconcile", () => {
  function mockBackend(statuses: Record<string, { type?: string }>) {
    return {
      url: "http://test",
      directory: "/tmp",
      configMode: "isolated" as const,
      client: {
        session: {
          status: async () => ({ data: statuses }),
        },
      },
    } as unknown as Parameters<SubagentTracker["reconcile"]>[0]
  }

  it("marks rows complete when opencode reports their child session idle", async () => {
    const { tracker, store, subscription } = setupTracker()
    const seed: AgentTask = {
      id: subagentTaskIDByChildSession("ses_child_done"),
      kind: "subagent",
      conversationID: "conv1",
      sessionID: "ses_parent",
      callID: "c1",
      childSessionID: "ses_child_done",
      title: "old task",
      status: "running",
      startedAt: 1,
      updatedAt: 1,
    }
    await store.upsert(seed)
    await tracker.reconcile(mockBackend({ ses_child_done: { type: "idle" } }), "ses_parent")
    expect(store.get(seed.id)!.status).toBe("completed")
    expect(subscription.added).not.toContain("ses_child_done")
  })

  it("resumes tracking when opencode reports the child still busy", async () => {
    const { tracker, store, subscription } = setupTracker()
    const seed: AgentTask = {
      id: subagentTaskIDByChildSession("ses_child_busy"),
      kind: "subagent",
      conversationID: "conv1",
      sessionID: "ses_parent",
      callID: "c1",
      childSessionID: "ses_child_busy",
      title: "still working",
      status: "running",
      startedAt: 1,
      updatedAt: 1,
    }
    await store.upsert(seed)
    await tracker.reconcile(mockBackend({ ses_child_busy: { type: "busy" } }), "ses_parent")
    expect(store.get(seed.id)!.status).toBe("running")
    expect(subscription.added).toContain("ses_child_busy")
  })

  it("completes rows whose child session is no longer in /session/status (server forgot)", async () => {
    const { tracker, store } = setupTracker()
    const seed: AgentTask = {
      id: subagentTaskIDByChildSession("ses_gone"),
      kind: "subagent",
      conversationID: "conv1",
      sessionID: "ses_parent",
      callID: "c1",
      childSessionID: "ses_gone",
      title: "vanished",
      status: "running",
      startedAt: 1,
      updatedAt: 1,
    }
    await store.upsert(seed)
    await tracker.reconcile(mockBackend({}), "ses_parent")
    expect(store.get(seed.id)!.status).toBe("completed")
  })

  it("skips reconcile for rows whose conversationID does NOT match (cross-conversation safety)", async () => {
    const { tracker, store } = setupTracker({ conversationID: "conv1" })
    const seed: AgentTask = {
      id: subagentTaskIDByChildSession("ses_other_conv"),
      kind: "subagent",
      conversationID: "other_conv",
      sessionID: "ses_parent",
      callID: "c1",
      childSessionID: "ses_other_conv",
      title: "not ours",
      status: "running",
      startedAt: 1,
      updatedAt: 1,
    }
    await store.upsert(seed)
    await tracker.reconcile(mockBackend({ ses_other_conv: { type: "idle" } }), "ses_parent")
    expect(store.get(seed.id)!.status).toBe("running")
  })
})

describe("SubagentTracker.cancelForSession", () => {
  it("settles every active subagent for the parent, unregisters child sessions, and returns their IDs", async () => {
    const { tracker, store, subscription } = setupTracker({ sessionID: "ses_parent" })
    await tracker.handleToolUpdate(
      makeUpdate({
        callID: "c1",
        status: "running",
        metadata: { sessionId: "ses_child_a" },
      }),
    )
    await tracker.handleToolUpdate(
      makeUpdate({
        callID: "c2",
        status: "running",
        metadata: { sessionId: "ses_child_b", run_in_background: true },
      }),
    )
    const aborted = await tracker.cancelForSession("ses_parent")
    expect(aborted.sort()).toEqual(["ses_child_a", "ses_child_b"])
    expect(store.get(subagentTaskIDByChildSession("ses_child_a"))!.status).toBe("cancelled")
    expect(store.get(subagentTaskIDByChildSession("ses_child_b"))!.status).toBe("cancelled")
    expect(subscription.removed.sort()).toEqual(["ses_child_a", "ses_child_b"])
  })

  it("clears dispatches so a follow-up event with the same callID does not see a stale entry", async () => {
    const { tracker, store } = setupTracker({ sessionID: "ses_parent" })
    await tracker.handleToolUpdate(
      makeUpdate({
        callID: "c1",
        status: "running",
        metadata: { sessionId: "ses_child_a" },
      }),
    )
    await tracker.cancelForSession("ses_parent")
    // A late tool-completed event with the same callID should NOT find
    // a live dispatch — it goes through the "no live dispatch" path and
    // the terminal guard on the cancelled row blocks resurrection.
    await tracker.handleToolUpdate(
      makeUpdate({ callID: "c1", status: "completed", metadata: { sessionId: "ses_child_a" } }),
    )
    expect(store.get(subagentTaskIDByChildSession("ses_child_a"))!.status).toBe("cancelled")
  })

  it("returns an empty list and is a no-op when there are no active subagents", async () => {
    const { tracker, subscription } = setupTracker({ sessionID: "ses_parent" })
    const aborted = await tracker.cancelForSession("ses_parent")
    expect(aborted).toEqual([])
    expect(subscription.removed).toEqual([])
  })

  it("leaves subagents under OTHER parent sessions alone (single-conversation scope)", async () => {
    const { tracker, store, subscription } = setupTracker({ sessionID: "ses_parent" })
    await tracker.handleToolUpdate(
      makeUpdate({
        callID: "c1",
        status: "running",
        metadata: { sessionId: "ses_child_a" },
      }),
    )
    // Seed a row owned by a DIFFERENT parent session directly via the store
    // (we don't have a clean tracker entry point for cross-session seeds).
    await store.upsert({
      id: subagentTaskIDByChildSession("ses_other_child"),
      kind: "subagent",
      conversationID: "conv1",
      sessionID: "ses_other_parent",
      childSessionID: "ses_other_child",
      title: "elsewhere",
      status: "running",
      startedAt: 1,
      updatedAt: 1,
    })
    await tracker.cancelForSession("ses_parent")
    expect(store.get(subagentTaskIDByChildSession("ses_child_a"))!.status).toBe("cancelled")
    expect(store.get(subagentTaskIDByChildSession("ses_other_child"))!.status).toBe("running")
    expect(subscription.removed).toEqual(["ses_child_a"])
  })
})

describe("SubagentTracker tool name gate", () => {
  it("does not touch the store for unrelated tools", async () => {
    const { tracker, store } = setupTracker()
    await tracker.handleToolUpdate(makeUpdate({ tool: "read", callID: "c_read" }))
    await tracker.handleToolUpdate(makeUpdate({ tool: "grep", callID: "c_grep" }))
    expect(store.list()).toEqual([])
  })

  it("does not touch the store before a parent sessionID exists", async () => {
    const memento = new FakeMemento()
    const store = new AgentTaskStore(memento)
    const subscription = new FakeSubscription()
    const tracker = new SubagentTracker({
      store,
      getActiveConversationID: () => "conv1",
      getParentSessionID: () => undefined,
      subscription,
    })
    await tracker.handleToolUpdate(makeUpdate({ callID: "c1" }))
    expect(store.list()).toEqual([])
  })

  it("recognizes every dispatch tool name (task, call_omo_agent, background_task, delegate_task, defensives)", () => {
    for (const tool of ["task", "Task", "task_tool", "delegate_task", "call_omo_agent", "background_task"]) {
      expect(SubagentTracker.isSubagentDispatchTool(tool)).toBe(true)
    }
    for (const tool of ["read", "edit", "tasks", "background_output", "background_cancel"]) {
      expect(SubagentTracker.isSubagentDispatchTool(tool)).toBe(false)
    }
  })
})
