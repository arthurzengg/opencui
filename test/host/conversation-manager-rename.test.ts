import { afterEach, describe, expect, it, vi } from "vitest"
import { ConversationManager } from "../../src/chat/conversation-manager"

function fakeContext() {
  const store = new Map<string, unknown>()
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

describe("ConversationManager.rename (#760)", () => {
  afterEach(() => vi.restoreAllMocks())

  it("keeps the date and the place in the list", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000)
    const manager = new ConversationManager(fakeContext())
    const older = manager.getActiveID()
    now.mockReturnValue(2_000)
    const newer = manager.add("Newer").id

    now.mockReturnValue(3_000)
    manager.rename(older, "Renamed")

    expect(manager.summaries()).toEqual([
      { id: newer, title: "Newer", updatedAt: 2_000 },
      { id: older, title: "Renamed", updatedAt: 1_000 },
    ])
  })
})
