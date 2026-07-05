import { describe, it, expect, vi, afterEach } from "vitest"
import { ConversationManager } from "../../src/chat/conversation-manager"
import type { ActiveSnapshot } from "../../src/chat/conversation-manager"

function fakeContext() {
  const store = new Map<string, unknown>()
  const workspaceState = {
    get: <T>(key: string, def?: T): T => (store.has(key) ? (store.get(key) as T) : (def as T)),
    update: vi.fn((key: string, value: unknown) => {
      if (value === undefined) store.delete(key)
      else store.set(key, value)
      return Promise.resolve()
    }),
    keys: () => [...store.keys()],
  }
  return { context: { workspaceState } as never }
}

function withMessage(): ActiveSnapshot {
  return {
    messages: [{ id: "m0", role: "user", blocks: [], pending: false }],
    reviewHunks: {},
  } as unknown as ActiveSnapshot
}

describe("ConversationManager.addOrReuseEmpty", () => {
  afterEach(() => vi.restoreAllMocks())

  it("reuses the active untouched New conversation instead of stacking a duplicate", () => {
    const { context } = fakeContext()
    const manager = new ConversationManager(context)
    const originalID = manager.getActiveID()
    expect(manager.summaries()).toHaveLength(1)

    const { conversation, reused } = manager.addOrReuseEmpty("New conversation")

    expect(reused).toBe(true)
    expect(conversation.id).toBe(originalID)
    expect(manager.summaries()).toHaveLength(1) // no duplicate empty chat
  })

  it("bumps the reused conversation's timestamp so it re-sorts to the top", () => {
    let now = 1_000
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const { context } = fakeContext()
    const manager = new ConversationManager(context)
    const before = manager.summaries()[0]!.updatedAt

    now = 5_000
    const { conversation, reused } = manager.addOrReuseEmpty("New conversation")

    expect(reused).toBe(true)
    expect(conversation.createdAt).toBe(5_000)
    expect(manager.summaries()[0]!.updatedAt).toBe(5_000)
    expect(manager.summaries()[0]!.updatedAt).toBeGreaterThan(before)
  })

  it("reuses an untouched New conversation even when another chat is active", () => {
    const { context } = fakeContext()
    const manager = new ConversationManager(context)
    const untouchedID = manager.getActiveID()
    const touched = manager.add("Touched chat")
    manager.setActiveID(touched.id)
    manager.saveActiveSnapshot(withMessage())

    const { conversation, reused } = manager.addOrReuseEmpty("New conversation")

    expect(reused).toBe(true)
    expect(conversation.id).toBe(untouchedID)
    expect(manager.summaries()).toHaveLength(2) // no duplicate empty chat
  })

  it("prefers the active conversation when several untouched New conversations exist", () => {
    const { context } = fakeContext()
    const manager = new ConversationManager(context)
    const second = manager.add("New conversation")
    manager.setActiveID(second.id)

    const { conversation, reused } = manager.addOrReuseEmpty("New conversation")

    expect(reused).toBe(true)
    expect(conversation.id).toBe(second.id)
  })

  it("adds a fresh conversation when the active one already has messages", () => {
    const { context } = fakeContext()
    const manager = new ConversationManager(context)
    manager.saveActiveSnapshot(withMessage())

    const { conversation, reused } = manager.addOrReuseEmpty("New conversation")

    expect(reused).toBe(false)
    expect(conversation.id).not.toBe(manager.getActiveID())
    expect(manager.summaries()).toHaveLength(2)
  })

  it("adds a fresh conversation when the active one was renamed off the default title", () => {
    const { context } = fakeContext()
    const manager = new ConversationManager(context)
    manager.rename(manager.getActiveID(), "Planning notes")

    const { reused } = manager.addOrReuseEmpty("New conversation")

    expect(reused).toBe(false)
    expect(manager.summaries()).toHaveLength(2)
  })
})
