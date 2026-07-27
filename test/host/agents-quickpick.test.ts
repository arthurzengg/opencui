import { describe, it, expect, beforeEach, vi } from "vitest"
import * as vscode from "vscode"
import { AgentTaskStore, type AgentTask, type Memento } from "../../src/agents/task-store"
import {
  buildQuickPickItems,
  formatElapsed,
  showAgentsQuickPick,
} from "../../src/agents/quickpick"

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

describe("Agents QuickPick", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("groups tasks under Main and Subagents separators", () => {
    const items = buildQuickPickItems([
      task({ id: "main:c:s", kind: "main", title: "Upgrade React 19", startedAt: 1000 }),
      task({ id: "subagent:s:c1", kind: "subagent", title: "Fix TS errors", callID: "c1", startedAt: 2000 }),
      task({ id: "subagent:s:c2", kind: "subagent", title: "Review tests", callID: "c2", startedAt: 3000 }),
    ])
    const labels = items.map((i) => i.label)
    expect(labels).toEqual([
      "Main",
      "Upgrade React 19",
      "Subagents",
      "Fix TS errors",
      "Review tests",
    ])
  })

  it("uses separator kind for the section headings", () => {
    const items = buildQuickPickItems([task(), task({ id: "subagent:s:c", kind: "subagent", callID: "c" })])
    const separators = items.filter((i) => i.kind === vscode.QuickPickItemKind.Separator)
    expect(separators.map((s) => s.label)).toEqual(["Main", "Subagents"])
  })

  it("orders entries by startedAt within each group", () => {
    const items = buildQuickPickItems([
      task({ id: "subagent:s:b", kind: "subagent", title: "B", callID: "b", startedAt: 2000 }),
      task({ id: "subagent:s:a", kind: "subagent", title: "A", callID: "a", startedAt: 1500 }),
      task({ id: "main:c:s", kind: "main", title: "M", startedAt: 1000 }),
    ])
    const labels = items.map((i) => i.label).filter((l) => l !== "Main" && l !== "Subagents")
    expect(labels).toEqual(["M", "A", "B"])
  })

  it("omits the Subagents section when only main tasks exist", () => {
    const items = buildQuickPickItems([task()])
    const sectionLabels = items.filter((i) => i.kind === vscode.QuickPickItemKind.Separator).map((i) => i.label)
    expect(sectionLabels).toEqual(["Main"])
  })

  it("omits the Main section when only subagents exist", () => {
    const items = buildQuickPickItems([
      task({ id: "subagent:s:a", kind: "subagent", title: "A", callID: "a" }),
    ])
    const sectionLabels = items.filter((i) => i.kind === vscode.QuickPickItemKind.Separator).map((i) => i.label)
    expect(sectionLabels).toEqual(["Subagents"])
  })

  it("formats elapsed time concisely", () => {
    expect(formatElapsed(0, 5000)).toBe("5s")
    expect(formatElapsed(0, 65_000)).toBe("1m")
    expect(formatElapsed(0, 65 * 60 * 1000)).toBe("1h 5m")
    expect(formatElapsed(0, 3 * 60 * 60 * 1000)).toBe("3h")
  })

  it("includes status + elapsed in the item description", () => {
    const items = buildQuickPickItems([task({ status: "running", startedAt: Date.now() - 12_000 })])
    const item = items.find((i) => i.label === "Main")! // wait, "Main" is the separator
    expect(item.kind).toBe(vscode.QuickPickItemKind.Separator)
    const row = items.find((i) => i.taskID)!
    expect(row.description).toMatch(/running/)
    expect(row.description).toMatch(/\d+s|\d+m/)
  })

  it("shows error details in the description for error-state tasks", () => {
    const items = buildQuickPickItems([task({ status: "error", error: "boom" })])
    const row = items.find((i) => i.taskID)!
    expect(row.description).toMatch(/error: boom/)
  })

  it("shows the 'No active agents' empty state when nothing is active", async () => {
    const memento = new FakeMemento()
    const store = new AgentTaskStore(memento)
    const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>
    showQuickPick.mockResolvedValueOnce(undefined)
    await showAgentsQuickPick(store, "c")
    const args = showQuickPick.mock.calls[0]![0] as Array<{ label: string }>
    expect(args[0]!.label).toBe("No active agents")
  })

  it("focuses the chat panel when the user picks a task", async () => {
    const memento = new FakeMemento()
    const store = new AgentTaskStore(memento)
    await store.upsert(task({ status: "running" }))
    const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>
    const exec = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>
    showQuickPick.mockResolvedValueOnce({ label: "Main", taskID: "main:c:s" })
    await showAgentsQuickPick(store, "c")
    expect(exec).toHaveBeenCalledWith("opencui.chat.focus")
  })

  it("does not focus the chat panel when the user dismisses the picker", async () => {
    const memento = new FakeMemento()
    const store = new AgentTaskStore(memento)
    await store.upsert(task({ status: "running" }))
    const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>
    const exec = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>
    showQuickPick.mockResolvedValueOnce(undefined)
    await showAgentsQuickPick(store, "c")
    expect(exec).not.toHaveBeenCalled()
  })

  it("lists only the active conversation's tasks", async () => {
    const memento = new FakeMemento()
    const store = new AgentTaskStore(memento)
    await store.upsert(task({ id: "main:c:s", conversationID: "c", title: "Mine", status: "running" }))
    await store.upsert(
      task({
        id: "main:other:s2",
        conversationID: "other",
        sessionID: "s2",
        title: "Other chat",
        status: "running",
      }),
    )
    const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>
    showQuickPick.mockResolvedValueOnce(undefined)
    await showAgentsQuickPick(store, "c")
    const items = showQuickPick.mock.calls[0]![0] as Array<{ label: string }>
    expect(items.map((i) => i.label)).toEqual(["Main", "Mine"])
  })

  it("shows the empty state when only other conversations have active work", async () => {
    const memento = new FakeMemento()
    const store = new AgentTaskStore(memento)
    await store.upsert(
      task({ id: "main:other:s2", conversationID: "other", sessionID: "s2", status: "running" }),
    )
    const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>
    showQuickPick.mockResolvedValueOnce(undefined)
    await showAgentsQuickPick(store, "c")
    const args = showQuickPick.mock.calls[0]![0] as Array<{ label: string }>
    expect(args[0]!.label).toBe("No active agents")
  })
})
