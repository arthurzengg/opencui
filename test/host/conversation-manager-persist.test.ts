import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ConversationManager } from "../../src/chat/conversation-manager"
import { ACTIVE_CONVERSATION_KEY, CONVERSATIONS_KEY } from "../../src/chat/conversation-store"

type Store = Map<string, unknown>

function fakeContext() {
  const store: Store = new Map()
  const update = vi.fn((key: string, value: unknown) => {
    if (value === undefined) store.delete(key)
    else store.set(key, value)
    return Promise.resolve()
  })
  const workspaceState = {
    get: <T>(key: string, def?: T): T => (store.has(key) ? (store.get(key) as T) : (def as T)),
    update,
    keys: () => [...store.keys()],
  }
  return { context: { workspaceState } as never, store, update }
}

type Snapshot = Parameters<ConversationManager["saveActiveSnapshot"]>[0]

// Cumulative assistant messages m0..m{n-1}, simulating a growing stream.
function snap(count: number, pending = false): Snapshot {
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: "assistant",
    blocks: [],
    pending,
  }))
  return { sessionID: "s1", messages, reviewHunks: {} } as unknown as Snapshot
}

function activeMessages(store: Store): Array<{ id: string }> {
  const conversations = store.get(CONVERSATIONS_KEY) as Array<{ messages: Array<{ id: string }> }>
  return conversations[0]!.messages
}

describe("ConversationManager debounced persistence", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("constructing the manager does not write to disk", () => {
    const { context, update } = fakeContext()
    new ConversationManager(context)
    expect(update).not.toHaveBeenCalled()
  })

  it("coalesces rapid schedulePersist calls into a single write of the latest state", async () => {
    const { context, store, update } = fakeContext()
    const manager = new ConversationManager(context)

    for (let i = 1; i <= 50; i++) {
      manager.saveActiveSnapshot(snap(i))
      manager.schedulePersist()
    }
    // Nothing hits disk until the debounce window elapses.
    expect(update).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)

    // The first persist writes both keys: construction added a conversation
    // and made it active, so both changed since they were read.
    expect(update).toHaveBeenCalledTimes(2)
    // The single coalesced write holds the latest state, not a stale prefix.
    const messages = activeMessages(store)
    expect(messages).toHaveLength(50)
    expect(messages.at(-1)!.id).toBe("m49")
  })

  it("flushPersist writes immediately and cancels the pending timer", async () => {
    const { context, update } = fakeContext()
    const manager = new ConversationManager(context)

    manager.saveActiveSnapshot(snap(1))
    manager.schedulePersist()
    await manager.flushPersist()
    expect(update).toHaveBeenCalledTimes(2) // wrote synchronously, no timer wait

    update.mockClear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(update).not.toHaveBeenCalled() // the pending timer was cancelled by the flush
  })

  it("a timer firing after dispose is a no-op", async () => {
    const { context, update } = fakeContext()
    const manager = new ConversationManager(context)

    manager.saveActiveSnapshot(snap(1))
    manager.schedulePersist()
    manager.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(update).not.toHaveBeenCalled()
  })

  it("a re-schedule mid-window does not push the 1 s deadline out", async () => {
    const { context, update } = fakeContext()
    const manager = new ConversationManager(context)

    manager.saveActiveSnapshot(snap(1))
    manager.schedulePersist()
    await vi.advanceTimersByTimeAsync(700)
    manager.saveActiveSnapshot(snap(2))
    manager.schedulePersist() // non-resetting: must not delay the original deadline
    expect(update).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300) // now 1 s after the first schedule
    expect(update).toHaveBeenCalledTimes(2)
  })

  it("a lifecycle flush after a stream persists the final transcript; reload re-stamps pending:false", async () => {
    const { context } = fakeContext()
    const manager = new ConversationManager(context)

    for (let i = 1; i <= 5; i++) {
      manager.saveActiveSnapshot(snap(i, true)) // streaming snapshots are pending
      manager.schedulePersist()
    }
    await manager.flushPersist() // stands in for the sessionIdle / boundary flush

    // A fresh manager hydrates exactly what was persisted, with pending cleared.
    const reloaded = new ConversationManager(context)
    const restored = reloaded.loadActiveSnapshot()
    expect(restored.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3", "m4"])
    expect(restored.messages.every((m) => m.pending === false)).toBe(true)
  })
})

// Every workspaceState.update reserializes the whole memento, so persist()
// writes a key only when its value changed since it was last read or written
// (#599).
describe("ConversationManager persist writes only changed keys", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function conversation(id: string) {
    return { id, title: id, createdAt: 1, updatedAt: 1, messages: [], reviewHunks: {} }
  }

  function writtenKeys(update: ReturnType<typeof fakeContext>["update"]) {
    return update.mock.calls.map((c) => c[0])
  }

  it("a stream costs one write per tick once the active id is on disk", async () => {
    const { context, update } = fakeContext()
    const manager = new ConversationManager(context)
    await manager.flushPersist()
    update.mockClear()

    for (let i = 1; i <= 10; i++) {
      manager.saveActiveSnapshot(snap(i))
      manager.schedulePersist()
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(writtenKeys(update)).toEqual([CONVERSATIONS_KEY])
  })

  it("a flush with nothing changed writes nothing", async () => {
    const { context, update } = fakeContext()
    const manager = new ConversationManager(context)
    await manager.flushPersist()
    update.mockClear()

    await manager.flushPersist()
    expect(update).not.toHaveBeenCalled()
  })

  it("constructing over an intact store makes the first persist a no-op", async () => {
    const { context, store, update } = fakeContext()
    store.set(CONVERSATIONS_KEY, [conversation("c1"), conversation("c2")])
    store.set(ACTIVE_CONVERSATION_KEY, "c1")
    const manager = new ConversationManager(context)

    await manager.persist()
    expect(update).not.toHaveBeenCalled()
  })

  it("only the active id is written when only it changed", async () => {
    const { context, store, update } = fakeContext()
    store.set(CONVERSATIONS_KEY, [conversation("c1"), conversation("c2")])
    store.set(ACTIVE_CONVERSATION_KEY, "c1")
    const manager = new ConversationManager(context)

    manager.setActiveID("c2")
    await manager.flushPersist()
    expect(update.mock.calls).toEqual([[ACTIVE_CONVERSATION_KEY, "c2"]])

    // A stale stored id is corrected on the first persist the same way.
    const other = fakeContext()
    other.store.set(CONVERSATIONS_KEY, [conversation("c1")])
    other.store.set(ACTIVE_CONVERSATION_KEY, "gone")
    await new ConversationManager(other.context).persist()
    expect(other.update.mock.calls).toEqual([[ACTIVE_CONVERSATION_KEY, "c1"]])
  })

  it("a rejected write is retried by the next persist", async () => {
    const { context, store, update } = fakeContext()
    const manager = new ConversationManager(context)
    update.mockRejectedValueOnce(new Error("disk"))

    await expect(manager.persist()).rejects.toThrow("disk")
    expect(store.has(CONVERSATIONS_KEY)).toBe(false)

    await manager.persist()
    expect(store.has(CONVERSATIONS_KEY)).toBe(true)
    expect(store.get(ACTIVE_CONVERSATION_KEY)).toBe(manager.getActiveID())
  })
})
