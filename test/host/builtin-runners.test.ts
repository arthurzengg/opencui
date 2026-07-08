import { describe, it, expect, beforeEach, vi } from "vitest"
import * as vscode from "vscode"
import { BuiltinRunners, type BuiltinRunnerDeps } from "../../src/chat/builtin-runners"
import type { Backend } from "../../src/server"
import type { ChatMessage, Outbound, ReviewHunkState } from "../../src/protocol"

// Drives BuiltinRunners against a stubbed SDK session client and a spy-backed
// deps closure (the same deps ChatView injects), so each command's server call
// and local state mutations are asserted without constructing a ChatView.

const win = vscode.window as unknown as {
  showInformationMessage: ReturnType<typeof vi.fn>
  showWarningMessage: ReturnType<typeof vi.fn>
  showErrorMessage: ReturnType<typeof vi.fn>
}
const writeText = vscode.env.clipboard.writeText as unknown as ReturnType<typeof vi.fn>

function user(id: string, text: string, backendID?: string): ChatMessage {
  return { id, role: "user", blocks: [{ type: "text", text }], backendID }
}

function assistant(id: string, text: string, opts: { backendID?: string; pending?: boolean } = {}): ChatMessage {
  return { id, role: "assistant", blocks: [{ type: "text", text }], ...opts }
}

function makeBackend(session: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    url: "http://127.0.0.1:1234",
    directory: "/ws",
    client: { session },
  } as unknown as Backend
}

type HarnessOpts = {
  sessionID?: string | undefined
  messages?: ChatMessage[]
  redoStack?: ChatMessage[][]
  reviewHunks?: Record<string, ReviewHunkState>
  selection?: { modelProviderID?: string; modelID?: string }
  subscribed?: boolean
}

function makeHarness(opts: HarnessOpts = {}) {
  const state = {
    sessionID: "sessionID" in opts ? opts.sessionID : "sess_1",
    messages: opts.messages ?? [],
    redoStack: opts.redoStack ?? [],
    reviewHunks: opts.reviewHunks ?? {},
    posted: [] as Outbound[],
  }
  const manager = {
    updateActive: vi.fn(),
    flushPersist: vi.fn().mockResolvedValue(undefined),
    add: vi.fn((title: string) => ({ id: "conv_new", title })),
    setActiveID: vi.fn(),
  }
  const deps = {
    prefs: { get: vi.fn(() => opts.selection ?? { modelProviderID: "prov", modelID: "mod" }) },
    manager,
    getSessionID: () => state.sessionID,
    setSessionID: vi.fn((id: string) => {
      state.sessionID = id
    }),
    hasSubscription: vi.fn(() => opts.subscribed ?? true),
    attachSubscription: vi.fn().mockResolvedValue(undefined),
    beginBuiltinTurn: vi.fn().mockResolvedValue(undefined),
    post: vi.fn((msg: Outbound) => {
      state.posted.push(msg)
    }),
    getMessages: () => state.messages,
    setMessages: vi.fn((messages: ChatMessage[]) => {
      state.messages = messages
    }),
    getRedoStack: () => state.redoStack,
    getReviewHunks: () => state.reviewHunks,
    clearReviewHunks: vi.fn(() => {
      state.reviewHunks = {}
    }),
    saveActive: vi.fn(),
    sendConversationState: vi.fn(),
    queueReviewDecorationsSync: vi.fn(),
    resetSessionState: vi.fn(),
    applyActiveSnapshot: vi.fn(),
    refreshContextUsage: vi.fn().mockResolvedValue(undefined),
  }
  return {
    deps,
    state,
    manager,
    runners: new BuiltinRunners(deps as unknown as BuiltinRunnerDeps),
  }
}

beforeEach(() => {
  win.showInformationMessage.mockReset()
  win.showWarningMessage.mockReset()
  win.showErrorMessage.mockReset()
  writeText.mockReset()
})

describe("BuiltinRunners: /compact", () => {
  it("shows a notice and does not begin a turn without a session", async () => {
    const { runners, deps } = makeHarness({ sessionID: undefined })
    const summarize = vi.fn()
    await runners.run("compact", makeBackend({ summarize }))
    expect(win.showInformationMessage).toHaveBeenCalledWith("Nothing to compact yet.")
    expect(deps.beginBuiltinTurn).not.toHaveBeenCalled()
    expect(summarize).not.toHaveBeenCalled()
  })

  it("begins the turn and summarizes with the selected model", async () => {
    const { runners, deps } = makeHarness()
    const summarize = vi.fn().mockResolvedValue({ data: {} })
    const backend = makeBackend({ summarize })
    await runners.run("compact", backend)
    expect(deps.attachSubscription).not.toHaveBeenCalled()
    expect(deps.beginBuiltinTurn).toHaveBeenCalledWith("/compact")
    expect(summarize).toHaveBeenCalledWith({
      path: { id: "sess_1" },
      query: { directory: "/ws" },
      body: { providerID: "prov", modelID: "mod" },
    })
  })

  it("attaches the subscription first when none is live", async () => {
    const { runners, deps } = makeHarness({ subscribed: false })
    const summarize = vi.fn().mockResolvedValue({ data: {} })
    const backend = makeBackend({ summarize })
    await runners.run("compact", backend)
    expect(deps.attachSubscription).toHaveBeenCalledWith(backend, "sess_1")
  })

  it("omits the model body when no model is selected", async () => {
    const { runners } = makeHarness({ selection: {} })
    const summarize = vi.fn().mockResolvedValue({ data: {} })
    await runners.run("compact", makeBackend({ summarize }))
    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ body: undefined }))
  })
})

describe("BuiltinRunners: /init", () => {
  it("warns and aborts when no model is selected", async () => {
    const { runners } = makeHarness({ selection: {} })
    const create = vi.fn()
    const init = vi.fn()
    await runners.run("init", makeBackend({ create, init }))
    expect(win.showWarningMessage).toHaveBeenCalledWith("Select a model before running /init.")
    expect(create).not.toHaveBeenCalled()
    expect(init).not.toHaveBeenCalled()
  })

  it("creates and adopts a session when none exists, then runs init", async () => {
    const { runners, deps, manager } = makeHarness({ sessionID: undefined })
    const create = vi.fn().mockResolvedValue({ data: { id: "sess_new" } })
    const init = vi.fn().mockResolvedValue({ data: {} })
    const backend = makeBackend({ create, init })
    await runners.run("init", backend)
    expect(deps.setSessionID).toHaveBeenCalledWith("sess_new")
    expect(manager.updateActive).toHaveBeenCalled()
    expect(manager.flushPersist).toHaveBeenCalled()
    expect(deps.attachSubscription).toHaveBeenCalledWith(backend, "sess_new")
    expect(deps.beginBuiltinTurn).toHaveBeenCalledWith("/init")
    const body = init.mock.calls[0]![0].body
    expect(body.providerID).toBe("prov")
    expect(body.modelID).toBe("mod")
    expect(typeof body.messageID).toBe("string")
  })

  it("aborts without running init when session.create fails", async () => {
    const { runners, deps } = makeHarness({ sessionID: undefined })
    const create = vi.fn().mockResolvedValue({ error: "boom" })
    const init = vi.fn()
    await runners.run("init", makeBackend({ create, init }))
    expect(init).not.toHaveBeenCalled()
    expect(deps.beginBuiltinTurn).not.toHaveBeenCalled()
  })

  it("reuses the existing session and re-attaches when unsubscribed", async () => {
    const { runners, deps } = makeHarness({ subscribed: false })
    const create = vi.fn()
    const init = vi.fn().mockResolvedValue({ data: {} })
    const backend = makeBackend({ create, init })
    await runners.run("init", backend)
    expect(create).not.toHaveBeenCalled()
    expect(deps.attachSubscription).toHaveBeenCalledWith(backend, "sess_1")
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "sess_1" } }))
  })
})

describe("BuiltinRunners: /share", () => {
  it("shows a notice without a session", async () => {
    const { runners } = makeHarness({ sessionID: undefined })
    const share = vi.fn()
    await runners.run("share", makeBackend({ share }))
    expect(win.showInformationMessage).toHaveBeenCalledWith("Start a conversation before sharing.")
    expect(share).not.toHaveBeenCalled()
  })

  it("offers the share link and copies it when the user picks Copy Link", async () => {
    const { runners } = makeHarness()
    const share = vi.fn().mockResolvedValue({ data: { share: { url: "https://opncd.ai/s/abc" } } })
    win.showInformationMessage.mockResolvedValueOnce("Copy Link")
    await runners.run("share", makeBackend({ share }))
    expect(win.showInformationMessage).toHaveBeenCalledWith(
      "Session shared: https://opncd.ai/s/abc",
      "Copy Link",
    )
    expect(writeText).toHaveBeenCalledWith("https://opncd.ai/s/abc")
  })

  it("confirms plainly when the server returns no url", async () => {
    const { runners } = makeHarness()
    const share = vi.fn().mockResolvedValue({ data: {} })
    await runners.run("share", makeBackend({ share }))
    expect(win.showInformationMessage).toHaveBeenCalledWith("Session shared.")
    expect(writeText).not.toHaveBeenCalled()
  })

  it("shows an error when the share call fails", async () => {
    const { runners } = makeHarness()
    const share = vi.fn().mockResolvedValue({ error: "nope" })
    await runners.run("share", makeBackend({ share }))
    expect(win.showErrorMessage).toHaveBeenCalledWith("Failed to share session.")
  })
})

describe("BuiltinRunners: /unshare", () => {
  it("returns silently without a session", async () => {
    const { runners } = makeHarness({ sessionID: undefined })
    const unshare = vi.fn()
    await runners.run("unshare", makeBackend({ unshare }))
    expect(unshare).not.toHaveBeenCalled()
    expect(win.showInformationMessage).not.toHaveBeenCalled()
  })

  it("confirms when sharing is disabled", async () => {
    const { runners } = makeHarness()
    const unshare = vi.fn().mockResolvedValue({ data: {} })
    await runners.run("unshare", makeBackend({ unshare }))
    expect(win.showInformationMessage).toHaveBeenCalledWith("Session sharing disabled.")
  })

  it("shows an error when the call fails", async () => {
    const { runners } = makeHarness()
    const unshare = vi.fn().mockResolvedValue({ error: "nope" })
    await runners.run("unshare", makeBackend({ unshare }))
    expect(win.showErrorMessage).toHaveBeenCalledWith("Failed to disable sharing.")
  })
})

describe("BuiltinRunners: /undo", () => {
  it("shows a notice when no settled user turn exists", async () => {
    const { runners } = makeHarness({ messages: [user("u1", "hello")] })
    const revert = vi.fn()
    await runners.run("undo", makeBackend({ revert }))
    expect(win.showInformationMessage).toHaveBeenCalledWith("Nothing to undo.")
    expect(revert).not.toHaveBeenCalled()
  })

  it("reverts to the last settled turn, stashes the tail, and restores the prompt", async () => {
    const messages = [
      user("u1", "first", "b_u1"),
      assistant("a1", "answer one"),
      user("u2", "second", "b_u2"),
      assistant("a2", "answer two"),
    ]
    const { runners, deps, state } = makeHarness({
      messages,
      reviewHunks: { "src/x.ts:0": "accepted" },
    })
    const revert = vi.fn().mockResolvedValue({ data: {} })
    await runners.run("undo", makeBackend({ revert }))
    expect(revert).toHaveBeenCalledWith(expect.objectContaining({ body: { messageID: "b_u2" } }))
    expect(state.messages.map((m) => m.id)).toEqual(["u1", "a1"])
    expect(state.redoStack).toHaveLength(1)
    expect(state.redoStack[0]!.map((m) => m.id)).toEqual(["u2", "a2"])
    expect(deps.clearReviewHunks).toHaveBeenCalled()
    expect(deps.saveActive).toHaveBeenCalled()
    expect(deps.sendConversationState).toHaveBeenCalled()
    expect(state.posted).toContainEqual({ type: "setComposerText", text: "second" })
  })

  it("leaves state untouched when the revert fails", async () => {
    const messages = [user("u1", "first", "b_u1"), assistant("a1", "answer")]
    const { runners, deps, state } = makeHarness({ messages })
    const revert = vi.fn().mockResolvedValue({ error: "boom" })
    await runners.run("undo", makeBackend({ revert }))
    expect(win.showErrorMessage).toHaveBeenCalledWith("Failed to undo the last turn.")
    expect(state.messages).toHaveLength(2)
    expect(state.redoStack).toHaveLength(0)
    expect(deps.saveActive).not.toHaveBeenCalled()
  })
})

describe("BuiltinRunners: /redo", () => {
  it("shows a notice when the redo stack is empty", async () => {
    const { runners } = makeHarness()
    const unrevert = vi.fn()
    await runners.run("redo", makeBackend({ unrevert }))
    expect(win.showInformationMessage).toHaveBeenCalledWith("Nothing to redo.")
    expect(unrevert).not.toHaveBeenCalled()
  })

  it("unreverts and reappends the tail when restoring the latest turn", async () => {
    const tail = [user("u2", "second", "b_u2"), assistant("a2", "answer")]
    const { runners, state } = makeHarness({
      messages: [user("u1", "first", "b_u1")],
      redoStack: [tail],
    })
    const unrevert = vi.fn().mockResolvedValue({ data: {} })
    const revert = vi.fn()
    await runners.run("redo", makeBackend({ unrevert, revert }))
    expect(unrevert).toHaveBeenCalled()
    expect(revert).not.toHaveBeenCalled()
    expect(state.messages.map((m) => m.id)).toEqual(["u1", "u2", "a2"])
    expect(state.redoStack).toHaveLength(0)
    expect(state.posted).toContainEqual({ type: "setComposerText", text: "" })
  })

  it("moves the revert pointer to the next still-reverted tail when more remain", async () => {
    const older = [user("u2", "second", "b_u2"), assistant("a2", "two")]
    const newer = [user("u3", "third", "b_u3"), assistant("a3", "three")]
    const { runners, state } = makeHarness({
      messages: [user("u1", "first", "b_u1")],
      redoStack: [older, newer],
    })
    const revert = vi.fn().mockResolvedValue({ data: {} })
    const unrevert = vi.fn()
    await runners.run("redo", makeBackend({ revert, unrevert }))
    expect(revert).toHaveBeenCalledWith(expect.objectContaining({ body: { messageID: "b_u2" } }))
    expect(unrevert).not.toHaveBeenCalled()
    expect(state.messages.map((m) => m.id)).toEqual(["u1", "u3", "a3"])
    expect(state.redoStack).toHaveLength(1)
  })

  it("pushes the tail back when the server call fails", async () => {
    const tail = [user("u2", "second", "b_u2")]
    const { runners, state } = makeHarness({ messages: [], redoStack: [tail] })
    const unrevert = vi.fn().mockResolvedValue({ error: "boom" })
    await runners.run("redo", makeBackend({ unrevert }))
    expect(win.showErrorMessage).toHaveBeenCalledWith("Failed to redo.")
    expect(state.redoStack).toHaveLength(1)
    expect(state.messages).toHaveLength(0)
  })
})

describe("BuiltinRunners: /fork", () => {
  const forkClient = (opts: { serverIDs?: string[]; title?: string } = {}) => ({
    fork: vi.fn().mockResolvedValue({ data: { id: "sess_fork", title: opts.title ?? "Forked title" } }),
    messages: vi.fn().mockResolvedValue({
      data: (opts.serverIDs ?? ["n1", "n2"]).map((id) => ({ info: { id } })),
    }),
  })

  it("shows a notice without a session", async () => {
    const { runners } = makeHarness({ sessionID: undefined })
    const client = forkClient()
    await runners.run("fork", makeBackend(client))
    expect(win.showInformationMessage).toHaveBeenCalledWith("Nothing to fork yet.")
    expect(client.fork).not.toHaveBeenCalled()
  })

  it("adopts the forked session onto a new conversation and re-stamps backendIDs", async () => {
    const { runners, deps, state, manager } = makeHarness({
      messages: [user("u1", "hello", "old1"), assistant("a1", "resp", { backendID: "old2", pending: true })],
      reviewHunks: { "src/x.ts:0": "accepted" },
    })
    const client = forkClient()
    const backend = makeBackend(client)
    await runners.run("fork", backend)

    expect(deps.resetSessionState).toHaveBeenCalled()
    expect(manager.add).toHaveBeenCalledWith("Forked title")
    expect(manager.setActiveID).toHaveBeenCalledWith("conv_new")
    const updater = manager.updateActive.mock.calls[0]![0] as (c: Record<string, unknown>) => Record<string, unknown>
    const updated = updater({ id: "conv_new" })
    expect(updated.sessionID).toBe("sess_fork")
    const copied = updated.messages as ChatMessage[]
    expect(copied.map((m) => m.backendID)).toEqual(["n1", "n2"])
    expect(copied.every((m) => m.pending === false)).toBe(true)
    expect(updated.reviewHunks).toEqual({ "src/x.ts:0": "accepted" })
    expect(deps.applyActiveSnapshot).toHaveBeenCalled()
    expect(deps.attachSubscription).toHaveBeenCalledWith(backend, "sess_fork")
    expect(state.posted).toContainEqual({ type: "contextUsage", usage: undefined })
    expect(deps.refreshContextUsage).toHaveBeenCalledWith(backend)
  })

  it("keeps the copied backendIDs when the server message count mismatches", async () => {
    const { runners, manager } = makeHarness({
      messages: [user("u1", "hello", "old1"), assistant("a1", "resp", { backendID: "old2" })],
    })
    const client = forkClient({ serverIDs: ["n1"], title: "" })
    await runners.run("fork", makeBackend(client))
    expect(manager.add).toHaveBeenCalledWith("Forked chat")
    const updater = manager.updateActive.mock.calls[0]![0] as (c: Record<string, unknown>) => Record<string, unknown>
    const copied = updater({ id: "conv_new" }).messages as ChatMessage[]
    expect(copied.map((m) => m.backendID)).toEqual(["old1", "old2"])
  })

  it("shows an error when the fork call fails", async () => {
    const { runners, deps } = makeHarness({ messages: [user("u1", "hello", "old1")] })
    const fork = vi.fn().mockResolvedValue({ error: "boom" })
    await runners.run("fork", makeBackend({ fork }))
    expect(win.showErrorMessage).toHaveBeenCalledWith("Failed to fork the conversation.")
    expect(deps.resetSessionState).not.toHaveBeenCalled()
  })
})
