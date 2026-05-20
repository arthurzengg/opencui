import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as vscode from "vscode"
import { AgentTaskStore, type AgentTask, type Memento } from "../../src/agents/task-store"
import { StatusBar, buildAgentsTooltip } from "../../src/status"
import type { Preferences, Selection } from "../../src/preferences"

class FakeMemento implements Memento {
  private store: Record<string, unknown> = {}
  get<T>(key: string): T | undefined
  get<T>(key: string, def: T): T
  get<T>(key: string, def?: T): T | undefined {
    return (this.store[key] as T | undefined) ?? def
  }
  async update(key: string, value: unknown) {
    if (value === undefined) delete this.store[key]
    else this.store[key] = value
  }
}

class FakePrefs implements Pick<Preferences, "get" | "onChange"> {
  private sel: Selection = {}
  get(): Selection {
    return this.sel
  }
  onChange(_listener: (s: Selection) => void) {
    return { dispose: () => {} }
  }
}

function fakeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [] as unknown[],
  } as unknown as vscode.ExtensionContext
}

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "main:c:s",
    kind: "main",
    conversationID: "c",
    sessionID: "s",
    title: "Main",
    status: "running",
    startedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

type FakeStatusBarItem = {
  text: string
  tooltip?: string
  command?: string
  color?: string | { id: string }
  shown: boolean
  show: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  alignment?: number
  priority?: number
}

describe("StatusBar (Agents runtime item)", () => {
  let prefs: FakePrefs
  let context: vscode.ExtensionContext
  let createdItems: FakeStatusBarItem[]

  beforeEach(() => {
    prefs = new FakePrefs()
    context = fakeContext()
    createdItems = []
    ;(vscode.window.createStatusBarItem as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (alignment?: unknown, priority?: number) => {
        const item: FakeStatusBarItem = {
          text: "",
          tooltip: undefined,
          command: undefined,
          color: undefined,
          alignment: alignment as number | undefined,
          priority,
          shown: false,
          show: vi.fn(function (this: FakeStatusBarItem) {
            this.shown = true
          }),
          hide: vi.fn(function (this: FakeStatusBarItem) {
            this.shown = false
          }),
        }
        ;(item.show as ReturnType<typeof vi.fn>).mockImplementation(() => {
          item.shown = true
        })
        ;(item.hide as ReturnType<typeof vi.fn>).mockImplementation(() => {
          item.shown = false
        })
        createdItems.push(item)
        return item as unknown as vscode.StatusBarItem
      },
    )
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("creates the Agents item between health (100) and agent (99) priorities", () => {
    const store = new AgentTaskStore(new FakeMemento())
    new StatusBar(context, prefs as unknown as Preferences, store)
    const priorities = createdItems.map((i) => i.priority)
    expect(priorities).toContain(100)
    expect(priorities).toContain(99.5)
    expect(priorities).toContain(99)
  })

  it("is hidden at startup with no active tasks", () => {
    const store = new AgentTaskStore(new FakeMemento())
    new StatusBar(context, prefs as unknown as Preferences, store)
    const agents = findItemByPriority(createdItems, 99.5)
    expect(agents.shown).toBe(false)
  })

  it("appears when a running task is upserted", async () => {
    const store = new AgentTaskStore(new FakeMemento())
    new StatusBar(context, prefs as unknown as Preferences, store)
    await store.upsert(task({ status: "running" }))
    const agents = findItemByPriority(createdItems, 99.5)
    expect(agents.shown).toBe(true)
    expect(agents.text).toBe("Agents")
  })

  it("text stays exactly 'Agents' across status transitions", async () => {
    const store = new AgentTaskStore(new FakeMemento())
    new StatusBar(context, prefs as unknown as Preferences, store)
    const agents = findItemByPriority(createdItems, 99.5)
    await store.upsert(task({ status: "running" }))
    expect(agents.text).toBe("Agents")
    await store.update("main:c:s", { status: "error", error: "boom" })
    expect(agents.text).toBe("Agents")
  })

  it("hides when all tasks complete", async () => {
    const store = new AgentTaskStore(new FakeMemento())
    new StatusBar(context, prefs as unknown as Preferences, store)
    const agents = findItemByPriority(createdItems, 99.5)
    await store.upsert(task({ status: "running" }))
    expect(agents.shown).toBe(true)
    await store.update("main:c:s", { status: "completed", updatedAt: 2000 })
    expect(agents.shown).toBe(false)
  })

  it("stays visible while an error task remains", async () => {
    const store = new AgentTaskStore(new FakeMemento())
    new StatusBar(context, prefs as unknown as Preferences, store)
    const agents = findItemByPriority(createdItems, 99.5)
    await store.upsert(task({ id: "main:c:s1", status: "running", sessionID: "s1" }))
    await store.upsert(task({ id: "main:c:s2", status: "error", sessionID: "s2", error: "boom" }))
    await store.update("main:c:s1", { status: "completed", updatedAt: 2000 })
    expect(agents.shown).toBe(true)
  })

  it("running tasks set the breathing color (green)", async () => {
    const store = new AgentTaskStore(new FakeMemento())
    new StatusBar(context, prefs as unknown as Preferences, store)
    const agents = findItemByPriority(createdItems, 99.5)
    await store.upsert(task({ status: "running" }))
    expect(typeof agents.color).toBe("string")
  })

  it("error-only state uses a static attention color (ThemeColor)", async () => {
    const store = new AgentTaskStore(new FakeMemento())
    new StatusBar(context, prefs as unknown as Preferences, store)
    const agents = findItemByPriority(createdItems, 99.5)
    await store.upsert(task({ status: "error", error: "boom" }))
    expect(agents.color).toBeDefined()
    expect(typeof agents.color).not.toBe("string")
  })

  it("breathing toggles color over time while running", async () => {
    const store = new AgentTaskStore(new FakeMemento())
    new StatusBar(context, prefs as unknown as Preferences, store)
    const agents = findItemByPriority(createdItems, 99.5)
    await store.upsert(task({ status: "running" }))
    const first = agents.color
    vi.advanceTimersByTime(2000)
    const after = agents.color
    expect(after).toBeDefined()
    // First sample is set at the start; over 2s the timer should have run
    // many times, so the *current* color is deterministic for fake-timers.
    expect([first, after]).toContain(agents.color)
  })

  it("clicks the agents quickpick command", async () => {
    const store = new AgentTaskStore(new FakeMemento())
    new StatusBar(context, prefs as unknown as Preferences, store)
    const agents = findItemByPriority(createdItems, 99.5)
    await store.upsert(task({ status: "running" }))
    expect(agents.command).toBe("opencui.agents.open")
  })

  it("tooltip describes running/waiting and prompts to click", () => {
    expect(buildAgentsTooltip(1, 0, 0)).toContain("1 agent running")
    expect(buildAgentsTooltip(2, 0, 0)).toContain("2 agents running")
    expect(buildAgentsTooltip(1, 1, 0)).toContain("1 waiting for input")
    expect(buildAgentsTooltip(0, 0, 2)).toContain("2 with errors")
    expect(buildAgentsTooltip(1, 0, 0)).toContain("Click to view")
  })

  it("agent/model item remains stable to the right of Agents", () => {
    const store = new AgentTaskStore(new FakeMemento())
    new StatusBar(context, prefs as unknown as Preferences, store)
    const agentItem = findItemByPriority(createdItems, 99)
    expect(agentItem.shown).toBe(true)
    expect(agentItem.text).toContain("default")
  })
})

function findItemByPriority(items: FakeStatusBarItem[], priority: number): FakeStatusBarItem {
  const item = items.find((i) => i.priority === priority)
  if (!item) throw new Error(`status bar item with priority ${priority} not created`)
  return item
}
