import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { startMockOpencode, type MockOpencodeServer } from "./mock-opencode-server"
import { ChatView } from "../../src/chat/view"
import type { ServerManager } from "../../src/server"
import type { Preferences } from "../../src/preferences"
import type { Inbound, Outbound } from "../../src/protocol"

/**
 * Behavioral contract of the Stop button, pinned end-to-end through the
 * webview's `{type: "abort"}` inbound message against the mock opencode
 * server. The abort APPROACH inside ChatView is allowed to change; these
 * assertions are the parts that must survive any rewrite:
 *
 *   1. The MAIN session is aborted, and aborted FIRST (a child's cancel
 *      result reaching a still-live parent used to spin up a new turn).
 *   2. Every RUNNING SUBAGENT is aborted too — the whole `session.children`
 *      subtree recursively, because opencode's own abort only propagates to
 *      foreground children. Background/orchestrator sessions (omo Sisyphus
 *      etc.) are independent sessions that keep dispatching new work if
 *      left alive (#343).
 *   3. Subagents the tracker knows about but `session.children` hasn't
 *      surfaced yet (just-spawned background workers) are seeded into the
 *      same sweep — including THEIR descendants.
 *   4. The webview and the task store learn about the stop immediately
 *      (synchronously), not after the network round-trip settles.
 *   5. A second Stop in the same conversation re-aborts the tree — a Stop
 *      generation must not be sticky across presses.
 */

type Store = Map<string, unknown>

function fakeMemento(initial: Record<string, unknown> = {}) {
  const store: Store = new Map(Object.entries(initial))
  return {
    get: <T>(key: string, def?: T): T => (store.has(key) ? (store.get(key) as T) : (def as T)),
    update: (key: string, value: unknown) => {
      if (value === undefined) store.delete(key)
      else store.set(key, value)
      return Promise.resolve()
    },
    keys: () => [...store.keys()],
  }
}

function fakeTaskStore() {
  return {
    upsert: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    cancelSessionTasks: vi.fn(async () => {}),
    clearErrored: vi.fn(async () => {}),
    activeSubagentsForSession: () => [],
    onDidChange: () => ({ dispose() {} }),
  }
}

type ChatViewInternals = {
  sessionID?: string
  aborting: boolean
  turnActive: boolean
  view: unknown
  subagentTracker?: unknown
  subagentDispatch: { recordMainTaskStart: (text: string) => Promise<void> }
  onMessage: (msg: Inbound) => Promise<void>
}

function internals(chat: ChatView): ChatViewInternals {
  return chat as unknown as ChatViewInternals
}

function makeChatView(server: MockOpencodeServer, taskStore?: ReturnType<typeof fakeTaskStore>) {
  const client = createOpencodeClient({ baseUrl: server.url })
  const backend = { url: server.url, client, directory: "/tmp" }
  const servers = { ensure: async () => backend } as unknown as ServerManager
  const prefs = { get: () => ({}) } as unknown as Preferences
  const context = {
    globalState: fakeMemento({ "opencui.migratedToWorkspaceState": true }),
    workspaceState: fakeMemento(),
  } as never
  const chat = new ChatView(context, servers, prefs, {} as never, {} as never, taskStore as never)
  const posts: Outbound[] = []
  internals(chat).view = {
    webview: { postMessage: (m: Outbound) => (posts.push(m), Promise.resolve(true)) },
  }
  return { chat, posts }
}

function stop(chat: ChatView): Promise<void> {
  return internals(chat).onMessage({ type: "abort" })
}

let server: MockOpencodeServer

beforeEach(async () => {
  server = await startMockOpencode()
})

afterEach(async () => {
  await server.close()
})

describe("Stop flow (webview abort → ChatView → opencode HTTP)", () => {
  it("aborts the main session AND every running subagent, main first", async () => {
    // Session tree while a deep agent runs: the main session has two live
    // children and one of them dispatched its own worker.
    server.setChildren("ses_main", ["ses_sub_a", "ses_sub_b"])
    server.setChildren("ses_sub_a", ["ses_sub_a_worker"])

    const { chat } = makeChatView(server)
    internals(chat).sessionID = "ses_main"
    internals(chat).turnActive = true

    await stop(chat)

    expect(server.aborts[0]).toBe("ses_main")
    expect(new Set(server.aborts)).toEqual(
      new Set(["ses_main", "ses_sub_a", "ses_sub_b", "ses_sub_a_worker"]),
    )
    expect(server.aborts).toHaveLength(4)
  })

  it("aborts tracker-known subagents that session.children has not surfaced yet — and their descendants", async () => {
    // A just-dispatched background orchestrator: opencode's tree doesn't
    // list it under the main session yet, only the tracker knows the child
    // session id. If Stop relied on session.children alone, the orchestrator
    // (and the worker it already spawned) would survive and keep dispatching.
    server.setChildren("ses_main", ["ses_sub_a"])
    server.setChildren("ses_orchestrator", ["ses_orch_worker"])

    const { chat } = makeChatView(server)
    internals(chat).sessionID = "ses_main"
    internals(chat).turnActive = true
    const cancelForSession = vi.fn(async () => ["ses_orchestrator"])
    internals(chat).subagentTracker = { cancelForSession }

    await stop(chat)

    expect(cancelForSession).toHaveBeenCalledWith("ses_main")
    expect(new Set(server.aborts)).toEqual(
      new Set(["ses_main", "ses_sub_a", "ses_orchestrator", "ses_orch_worker"]),
    )
  })

  it("tells the webview and enters the SSE-drop gate synchronously, before any abort lands", async () => {
    server.setChildren("ses_main", ["ses_sub_a"])
    const { chat, posts } = makeChatView(server)
    internals(chat).sessionID = "ses_main"
    internals(chat).turnActive = true

    const inFlight = stop(chat)

    // Synchronous with the button press: the UI must not wait on the network.
    expect(posts).toContainEqual({ type: "aborted" })
    expect(internals(chat).aborting).toBe(true)
    expect(server.aborts).toHaveLength(0)

    await inFlight
    expect(server.aborts).toContain("ses_main")
  })

  it("settles the turn's Main task row to cancelled and cancels the session's store rows", async () => {
    const taskStore = fakeTaskStore()
    const { chat } = makeChatView(server, taskStore)
    internals(chat).sessionID = "ses_main"
    internals(chat).turnActive = true

    // A turn is in flight: the Agents popover has a running Main row.
    await internals(chat).subagentDispatch.recordMainTaskStart("long prompt")
    expect(taskStore.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "main", status: "running" }),
    )
    const mainID = (taskStore.upsert.mock.calls[0]![0] as { id: string }).id

    await stop(chat)

    // The Main row must settle as cancelled (not error, not left running) …
    expect(taskStore.update).toHaveBeenCalledWith(
      mainID,
      expect.objectContaining({ status: "cancelled" }),
    )
    // … and without a tracker attached, the store sweep is the fallback that
    // settles subagent rows so the popover cannot show ghosts after Stop.
    expect(taskStore.cancelSessionTasks).toHaveBeenCalledWith("ses_main")
  })

  it("a second Stop re-aborts the same tree (generations are not sticky)", async () => {
    server.setChildren("ses_main", [])
    const { chat } = makeChatView(server)
    internals(chat).sessionID = "ses_main"
    internals(chat).turnActive = true

    await stop(chat)
    // The user sent another turn in the same session and pressed Stop again.
    await stop(chat)

    expect(server.aborts).toEqual(["ses_main", "ses_main"])
  })

  it("Stop with no active session is a no-op (no post, no network)", async () => {
    const { chat, posts } = makeChatView(server)

    await stop(chat)

    expect(posts).toEqual([])
    expect(internals(chat).aborting).toBe(false)
    expect(server.aborts).toEqual([])
  })

  it("Stop racing the turn's own completion re-idles the webview instead of wedging (#579)", async () => {
    // The turn already settled (sessionIdle was posted, turnActive cleared)
    // but the click landed before the webview rendered it. Aborting an idle
    // session emits no new session.idle, so entering the aborting state here
    // would leave the composer at "Stopping…" forever.
    const { chat, posts } = makeChatView(server)
    internals(chat).sessionID = "ses_main"

    await stop(chat)

    expect(posts).toContainEqual({ type: "sessionIdle" })
    expect(posts).not.toContainEqual({ type: "aborted" })
    expect(internals(chat).aborting).toBe(false)
    expect(server.aborts).toEqual([])
  })
})
