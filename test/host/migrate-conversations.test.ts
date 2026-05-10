import { describe, it, expect } from "vitest"
import { migrateConversationsToWorkspace } from "../../src/chat/conversation-store"

type Store = Map<string, unknown>

function fakeMemento(initial: Record<string, unknown> = {}) {
  const store: Store = new Map(Object.entries(initial))
  return {
    store,
    api: {
      get: <T>(key: string, def?: T): T => (store.has(key) ? (store.get(key) as T) : (def as T)),
      update: (key: string, value: unknown) => {
        if (value === undefined) store.delete(key)
        else store.set(key, value)
        return Promise.resolve()
      },
      keys: () => [...store.keys()],
    },
  }
}

function fakeContext(globalInit: Record<string, unknown> = {}, workspaceInit: Record<string, unknown> = {}) {
  const globalState = fakeMemento(globalInit)
  const workspaceState = fakeMemento(workspaceInit)
  return {
    context: { globalState: globalState.api, workspaceState: workspaceState.api } as never,
    globalState,
    workspaceState,
  }
}

describe("migrateConversationsToWorkspace", () => {
  it("does nothing when migration flag is already set", () => {
    const { context, globalState, workspaceState } = fakeContext(
      { "opencui.conversations": [{ id: "old" }] },
      { "opencui.migratedToWorkspaceState": true },
    )
    migrateConversationsToWorkspace(context)
    // Global still has its data — not migrated
    expect(globalState.store.get("opencui.conversations")).toEqual([{ id: "old" }])
    expect(workspaceState.store.has("opencui.conversations")).toBe(false)
  })

  it("migrates conversations from globalState to workspaceState on first run", () => {
    const { context, globalState, workspaceState } = fakeContext({
      "opencui.conversations": [{ id: "c1" }, { id: "c2" }],
      "opencui.activeConversation": "c1",
    })
    migrateConversationsToWorkspace(context)
    expect(workspaceState.store.get("opencui.conversations")).toEqual([{ id: "c1" }, { id: "c2" }])
    expect(workspaceState.store.get("opencui.activeConversation")).toBe("c1")
    expect(workspaceState.store.get("opencui.migratedToWorkspaceState")).toBe(true)
  })

  it("clears global keys after migration so a different workspace doesn't duplicate", () => {
    const { context, globalState } = fakeContext({
      "opencui.conversations": [{ id: "c1" }],
      "opencui.activeConversation": "c1",
    })
    migrateConversationsToWorkspace(context)
    expect(globalState.store.has("opencui.conversations")).toBe(false)
    expect(globalState.store.has("opencui.activeConversation")).toBe(false)
  })

  it("sets migrated flag even when there's nothing to migrate (idempotency)", () => {
    const { context, workspaceState } = fakeContext()
    migrateConversationsToWorkspace(context)
    expect(workspaceState.store.get("opencui.migratedToWorkspaceState")).toBe(true)
  })

  it("doesn't clear global keys when there are no legacy conversations", () => {
    const { context, globalState } = fakeContext({})
    migrateConversationsToWorkspace(context)
    expect(globalState.store.has("opencui.conversations")).toBe(false) // never had it
  })
})
