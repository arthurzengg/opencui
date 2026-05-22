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
  it("does nothing when migration flag is already set", async () => {
    const { context, globalState, workspaceState } = fakeContext(
      { "opencui.conversations": [{ id: "old" }] },
      { "opencui.migratedToWorkspaceState": true },
    )
    await migrateConversationsToWorkspace(context)
    // Global still has its data — not migrated
    expect(globalState.store.get("opencui.conversations")).toEqual([{ id: "old" }])
    expect(workspaceState.store.has("opencui.conversations")).toBe(false)
  })

  it("migrates conversations from globalState to workspaceState on first run", async () => {
    const { context, workspaceState } = fakeContext({
      "opencui.conversations": [{ id: "c1" }, { id: "c2" }],
      "opencui.activeConversation": "c1",
    })
    await migrateConversationsToWorkspace(context)
    expect(workspaceState.store.get("opencui.conversations")).toEqual([{ id: "c1" }, { id: "c2" }])
    expect(workspaceState.store.get("opencui.activeConversation")).toBe("c1")
    expect(workspaceState.store.get("opencui.migratedToWorkspaceState")).toBe(true)
  })

  it("clears global keys after migration so a different workspace doesn't duplicate", async () => {
    const { context, globalState } = fakeContext({
      "opencui.conversations": [{ id: "c1" }],
      "opencui.activeConversation": "c1",
    })
    await migrateConversationsToWorkspace(context)
    expect(globalState.store.has("opencui.conversations")).toBe(false)
    expect(globalState.store.has("opencui.activeConversation")).toBe(false)
  })

  it("sets migrated flag even when there's nothing to migrate (idempotency)", async () => {
    const { context, workspaceState } = fakeContext()
    await migrateConversationsToWorkspace(context)
    expect(workspaceState.store.get("opencui.migratedToWorkspaceState")).toBe(true)
  })

  it("doesn't clear global keys when there are no legacy conversations", async () => {
    const { context, globalState } = fakeContext({})
    await migrateConversationsToWorkspace(context)
    expect(globalState.store.has("opencui.conversations")).toBe(false) // never had it
  })

  it("leaves the migration flag unset when a data write rejects", async () => {
    const globalStore: Map<string, unknown> = new Map([["opencui.conversations", [{ id: "c1" }]]])
    const workspaceStore: Map<string, unknown> = new Map()
    const context = {
      globalState: {
        get: <T>(key: string, def?: T): T => (globalStore.has(key) ? (globalStore.get(key) as T) : (def as T)),
        update: (key: string, value: unknown) => {
          if (value === undefined) globalStore.delete(key)
          else globalStore.set(key, value)
          return Promise.resolve()
        },
        keys: () => [...globalStore.keys()],
      },
      workspaceState: {
        get: <T>(key: string, def?: T): T => (workspaceStore.has(key) ? (workspaceStore.get(key) as T) : (def as T)),
        update: (_key: string, _value: unknown) => Promise.reject(new Error("disk full")),
        keys: () => [...workspaceStore.keys()],
      },
    } as never
    await expect(migrateConversationsToWorkspace(context)).rejects.toThrow("disk full")
    // Migration flag must NOT be set — next activation retries.
    expect(workspaceStore.has("opencui.migratedToWorkspaceState")).toBe(false)
  })
})
