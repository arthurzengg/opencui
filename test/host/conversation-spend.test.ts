import { afterEach, describe, expect, it, vi } from "vitest"
import { ConversationManager } from "../../src/chat/conversation-manager"
import { CONVERSATIONS_KEY, type SavedConversation } from "../../src/chat/conversation-store"
import { readContextUsage } from "../../src/chat/context-usage"
import type { Backend } from "../../src/server"

function fakeContext(store = new Map<string, unknown>()) {
  const workspaceState = {
    get: <T>(key: string, def?: T): T => (store.has(key) ? (store.get(key) as T) : (def as T)),
    update: vi.fn((key: string, value: unknown) => {
      store.set(key, value)
      return Promise.resolve()
    }),
    keys: () => [...store.keys()],
  }
  return { workspaceState } as never
}

// The server deletes the messages of a turn that is edited and resent, or
// undone. The provider billed that turn all the same: in the checked session
// such turns were 15% of the bill (#792).
describe("a conversation's spend across removed turns (#792)", () => {
  afterEach(() => vi.restoreAllMocks())

  it("keeps what a removed turn cost, and adds what comes after", () => {
    const manager = new ConversationManager(fakeContext())
    const id = manager.getActiveID()
    expect(manager.trackSpend(id, 1.12)).toBeCloseTo(1.12, 6)
    // The turn that cost 0.4 was edited: the server now accounts for less.
    expect(manager.trackSpend(id, 0.72)).toBeCloseTo(1.12, 6)
    expect(manager.trackSpend(id, 0.9)).toBeCloseTo(1.3, 6)
  })

  it("survives a reload, and leaves the conversation's date and place alone", async () => {
    const store = new Map<string, unknown>()
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000)
    const manager = new ConversationManager(fakeContext(store))
    const older = manager.getActiveID()
    now.mockReturnValue(2_000)
    const newer = manager.add("Newer").id
    now.mockReturnValue(3_000)
    manager.trackSpend(older, 1.12)
    await manager.flushPersist()
    expect(manager.summaries().map((c) => [c.id, c.updatedAt])).toEqual([[newer, 2_000], [older, 1_000]])
    expect((store.get(CONVERSATIONS_KEY) as SavedConversation[]).map((c) => c.id)).toEqual([newer, older])

    const reloaded = new ConversationManager(fakeContext(store))
    expect(reloaded.trackSpend(older, 0.72)).toBeCloseTo(1.12, 6)
  })

  // Within a window the removed messages' costs are still known, so the
  // server's own figure does not drop and nothing is counted twice.
  it("does not count a removed turn twice within one window", async () => {
    const steps = [
      { id: "rm-a", cost: 0.4 },
      { id: "rm-b", cost: 0.3 },
    ]
    const api = {
      session: {
        messages: async () => ({
          data: steps.map((s) => ({ info: { id: s.id, role: "assistant", cost: s.cost, tokens: { input: 1, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] })),
          status: 200,
        }),
        children: async () => ({ data: [], status: 200 }),
      },
      config: { providers: async () => ({ data: { providers: [] }, status: 200 }) },
    }
    const backend = { url: "http://fake-spend", api } as unknown as Backend
    const manager = new ConversationManager(fakeContext())
    const id = manager.getActiveID()

    expect(manager.trackSpend(id, (await readContextUsage(backend, "spend-root"))!.cost!)).toBeCloseTo(0.7, 6)
    steps.pop()
    steps.push({ id: "rm-c", cost: 0.2 })
    expect(manager.trackSpend(id, (await readContextUsage(backend, "spend-root"))!.cost!)).toBeCloseTo(0.9, 6)
  })
})
