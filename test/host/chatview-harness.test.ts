import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as vscode from "vscode"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { startMockOpencode, type MockOpencodeServer } from "./mock-opencode-server"
import { ChatView } from "../../src/chat/view"
import { CONVERSATIONS_KEY, type SavedConversation } from "../../src/chat/conversation-store"
import { AgentTaskStore } from "../../src/agents/task-store"
import type { Backend, ServerManager } from "../../src/server"
import type { Preferences } from "../../src/preferences"
import type { RecentEditsTracker } from "../../src/workspace-context/recent-edits"
import type { IndexManager } from "../../src/indexing/index-manager"
import type { Inbound, Outbound } from "../../src/protocol"

// Constructs a real ChatView against the mock opencode server and a fake
// WebviewView, then drives it the way the webview would: post Inbound
// messages, script SSE events, and assert on the Outbound stream plus the
// workspaceState snapshot. This is the only test that exercises ChatView's
// own wiring (onMessage dispatch, applyLocal persistence mirror, abort
// gating) rather than the extracted modules.

const SESSION_ID = "ses_test" // what the mock server's POST /session returns

type Memento = {
  keys: () => readonly string[]
  get: (key: string, defaultValue?: unknown) => unknown
  update: (key: string, value: unknown) => Promise<void>
}

function makeMemento(): Memento {
  const store = new Map<string, unknown>()
  return {
    keys: () => [...store.keys()],
    get: (key, defaultValue) => (store.has(key) ? store.get(key) : defaultValue),
    update: async (key, value) => {
      if (value === undefined) store.delete(key)
      else store.set(key, value)
    },
  }
}

function makeFakeWebviewView() {
  const posted: Outbound[] = []
  let receive: ((msg: Inbound) => unknown) | undefined
  let disposeCb: (() => void) | undefined
  const view = {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      onDidReceiveMessage: (cb: (msg: Inbound) => unknown) => {
        receive = cb
        return { dispose: vi.fn() }
      },
      postMessage: (msg: Outbound) => {
        posted.push(msg)
        return Promise.resolve(true)
      },
      asWebviewUri: (uri: unknown) => uri,
    },
    onDidDispose: (cb: () => void) => {
      disposeCb = cb
      return { dispose: vi.fn() }
    },
    onDidChangeVisibility: () => ({ dispose: vi.fn() }),
    visible: true,
    show: vi.fn(),
  }
  return {
    view: view as unknown as vscode.WebviewView,
    posted,
    // resolveWebviewView registers a callback that returns onMessage's
    // promise, so awaiting this awaits the full host-side handling.
    send: (msg: Inbound) => Promise.resolve(receive?.(msg)),
    disposeView: () => disposeCb?.(),
  }
}

async function until(cond: () => boolean, ms = 4000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time")
    await new Promise((r) => setTimeout(r, 10))
  }
}

let server: MockOpencodeServer
let harness: {
  chatView: ChatView
  posted: Outbound[]
  send: (msg: Inbound) => Promise<unknown>
  disposeView: () => void
  workspaceState: Memento
  servers: ServerManager
  taskStore: AgentTaskStore
}

beforeEach(async () => {
  server = await startMockOpencode()
  const client = createOpencodeClient({ baseUrl: server.url })
  const backend = { url: server.url, client, directory: "/ws" } as unknown as Backend
  const servers = { ensure: vi.fn(async () => backend) } as unknown as ServerManager
  const prefs = {
    get: () => ({}),
    onChange: vi.fn(() => ({ dispose: vi.fn() })),
  } as unknown as Preferences
  const indexManager = {
    onStatusChange: vi.fn(() => ({ dispose: vi.fn() })),
    currentStatus: vi.fn(() => ({ state: "disabled" })),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as IndexManager
  const workspaceState = makeMemento()
  const context = {
    workspaceState,
    globalState: makeMemento(),
    extensionUri: vscode.Uri.file("/ext"),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext

  const taskStore = new AgentTaskStore(makeMemento() as unknown as vscode.Memento)
  const chatView = new ChatView(
    context,
    servers,
    prefs,
    {} as RecentEditsTracker, // only consulted when backend.workspace is set
    indexManager,
    taskStore,
  )
  const fake = makeFakeWebviewView()
  await chatView.resolveWebviewView(fake.view)
  harness = { chatView, posted: fake.posted, send: fake.send, disposeView: fake.disposeView, workspaceState, servers, taskStore }
})

afterEach(async () => {
  harness.disposeView() // aborts the SSE subscription and flushes persistence
  await server.close()
})

function savedConversations(): SavedConversation[] {
  return (harness.workspaceState.get(CONVERSATIONS_KEY) ?? []) as SavedConversation[]
}

describe("ChatView harness: mounted handshake", () => {
  it("posts ready, restores the default conversation, and reports connected", async () => {
    await harness.send({ type: "mounted" })
    const types = harness.posted.map((m) => m.type)
    expect(types[0]).toBe("ready")
    expect(types).toContain("conversations")
    expect(types).toContain("restore")
    const restore = harness.posted.find((m) => m.type === "restore")
    expect(restore && "messages" in restore ? restore.messages : undefined).toEqual([])
    expect(
      harness.posted.some((m) => m.type === "connected" && m.connected === true),
    ).toBe(true)
  })
})

describe("ChatView harness: send round-trip", () => {
  it("creates a session, dispatches the prompt, streams the reply, and persists the turn", async () => {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "hello there" })

    // The prompt reached the mock server against the created session.
    expect(server.prompts).toHaveLength(1)
    expect(server.prompts[0]!.sessionID).toBe(SESSION_ID)
    expect(JSON.stringify(server.prompts[0]!.body)).toContain("hello there")

    // The user bubble was posted optimistically before any SSE event.
    const userMsg = harness.posted.find((m) => m.type === "userMessage")
    expect(userMsg && "text" in userMsg ? userMsg.text : undefined).toBe("hello there")
    const userID = userMsg && "id" in userMsg ? userMsg.id : ""

    // Stream the turn: user association, assistant start, two text chunks,
    // terminal finish, idle.
    server.push({ type: "message.updated", info: { id: "usr_1", role: "user", sessionID: SESSION_ID } })
    await until(() =>
      harness.posted.some((m) => m.type === "userMessageBackendID" && m.backendID === "usr_1"),
    )
    const assoc = harness.posted.find((m) => m.type === "userMessageBackendID")
    expect(assoc && "id" in assoc ? assoc.id : undefined).toBe(userID)

    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION_ID } })
    server.push({
      type: "message.part.updated",
      part: { id: "part_1", messageID: "msg_a", sessionID: SESSION_ID, type: "text", text: "Hi" },
    })
    server.push({
      type: "message.part.updated",
      part: { id: "part_1", messageID: "msg_a", sessionID: SESSION_ID, type: "text", text: "Hi there" },
    })
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION_ID, finish: "stop" } })
    server.push({ type: "session.idle", sessionID: SESSION_ID })
    await until(() => harness.posted.some((m) => m.type === "sessionIdle"))

    expect(harness.posted.some((m) => m.type === "assistantStart" && m.id === "a_msg_a")).toBe(true)
    const deltas = harness.posted.flatMap((m) => (m.type === "textDelta" ? [m.delta] : []))
    expect(deltas.join("")).toBe("Hi there")
    expect(harness.posted.some((m) => m.type === "assistantDone" && m.id === "a_msg_a")).toBe(true)

    // What the webview rendered is exactly what got persisted.
    await harness.chatView.flushPersist()
    const conversations = savedConversations()
    expect(conversations).toHaveLength(1)
    const active = conversations[0]!
    expect(active.sessionID).toBe(SESSION_ID)
    expect(active.messages).toHaveLength(2)
    const [user, assistant] = active.messages
    expect(user!.role).toBe("user")
    expect(user!.backendID).toBe("usr_1")
    expect(user!.blocks).toContainEqual({ type: "text", text: "hello there" })
    expect(assistant!.role).toBe("assistant")
    expect(assistant!.blocks).toEqual([{ type: "text", text: "Hi there" }])
    expect(assistant!.pending).toBe(false)
    expect(assistant!.stopped).toBeUndefined()
  })
})

describe("ChatView harness: Stop mid-stream", () => {
  it("posts aborted, aborts the session subtree, drops late deltas, and persists the Stopped state", async () => {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "long task" })

    server.push({ type: "message.updated", info: { id: "usr_1", role: "user", sessionID: SESSION_ID } })
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION_ID } })
    server.push({
      type: "message.part.updated",
      part: { id: "part_1", messageID: "msg_a", sessionID: SESSION_ID, type: "text", text: "Working" },
    })
    await until(() => harness.posted.some((m) => m.type === "textDelta"))

    await harness.send({ type: "abort" })

    // The webview learned about the stop immediately and the server-side
    // abort hit the session (the whole-subtree sweep starts at the root).
    expect(harness.posted.some((m) => m.type === "aborted")).toBe(true)
    expect(server.aborts).toContain(SESSION_ID)

    // opencode keeps draining its in-flight response for a moment — those
    // deltas must not mutate the already-stopped message.
    server.push({
      type: "message.part.updated",
      part: { id: "part_1", messageID: "msg_a", sessionID: SESSION_ID, type: "text", text: "Working on it still" },
    })
    server.push({ type: "session.idle", sessionID: SESSION_ID })
    await until(() => harness.posted.some((m) => m.type === "sessionIdle"))

    const deltas = harness.posted.flatMap((m) => (m.type === "textDelta" ? [m.delta] : []))
    expect(deltas.join("")).toBe("Working")

    // The Stopped badge state is what gets persisted, not a pending message.
    await harness.chatView.flushPersist()
    const [active] = savedConversations()
    const assistant = active!.messages[1]
    expect(assistant!.role).toBe("assistant")
    expect(assistant!.stopped).toBe(true)
    expect(assistant!.pending).toBe(false)
    expect(assistant!.blocks).toEqual([{ type: "text", text: "Working" }])
  })
})

describe("ChatView harness: edit-in-place revert", () => {
  const EDIT_FAILED_TOAST = "Failed to edit the message. The conversation is unchanged."

  // One completed turn (user usr_1 + finished assistant, session idle) so
  // there is history the edit must either replace or leave intact.
  async function runTurn(): Promise<string> {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "original prompt" })
    server.push({ type: "message.updated", info: { id: "usr_1", role: "user", sessionID: SESSION_ID } })
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION_ID } })
    server.push({
      type: "message.part.updated",
      part: { id: "part_1", messageID: "msg_a", sessionID: SESSION_ID, type: "text", text: "answer" },
    })
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION_ID, finish: "stop" } })
    server.push({ type: "session.idle", sessionID: SESSION_ID })
    await until(() => harness.posted.some((m) => m.type === "sessionIdle"))
    const userMsg = harness.posted.find((m) => m.type === "userMessage")
    return userMsg && "id" in userMsg ? userMsg.id : ""
  }

  async function persistedConversation(): Promise<SavedConversation> {
    await harness.chatView.flushPersist()
    return savedConversations()[0]!
  }

  it("truncates the turn and resends when the revert succeeds", async () => {
    const userID = await runTurn()

    await harness.send({ type: "editMessage", id: userID, text: "edited prompt" })

    expect(server.reverts).toHaveLength(1)
    expect(JSON.stringify(server.reverts[0]!.body)).toContain("usr_1")
    expect(server.prompts).toHaveLength(2)
    expect(JSON.stringify(server.prompts[1]!.body)).toContain("edited prompt")

    const active = await persistedConversation()
    expect(active.messages).toHaveLength(1)
    expect(active.messages[0]!.blocks).toContainEqual({ type: "text", text: "edited prompt" })
  })

  it("aborts the edit when the revert reports an error: no truncation, no resend, a visible toast", async () => {
    const userID = await runTurn()
    server.setRevertStatus(500)

    await harness.send({ type: "editMessage", id: userID, text: "edited prompt" })

    expect(server.reverts).toHaveLength(1)
    expect(server.prompts).toHaveLength(1)
    expect(
      harness.posted.some((m) => m.type === "userMessage" && "text" in m && m.text === "edited prompt"),
    ).toBe(false)
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(EDIT_FAILED_TOAST)

    const active = await persistedConversation()
    expect(active.messages).toHaveLength(2)
    expect(active.messages[0]!.blocks).toContainEqual({ type: "text", text: "original prompt" })
    expect(active.messages[1]!.blocks).toContainEqual({ type: "text", text: "answer" })
  })

  it("aborts the edit when the revert call throws (connection drop): same untouched state", async () => {
    const userID = await runTurn()
    server.setRevertStatus(0)

    await harness.send({ type: "editMessage", id: userID, text: "edited prompt" })

    expect(server.prompts).toHaveLength(1)
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(EDIT_FAILED_TOAST)

    const active = await persistedConversation()
    expect(active.messages).toHaveLength(2)
  })
})

describe("ChatView harness: pre-dispatch send failures", () => {
  // The user bubble is already posted and the webview is busy by the time
  // these paths fail; failSend's sessionIdle is the only thing that re-enables
  // the composer, because a send that never dispatched produces no SSE events.

  it("posts sessionIdle and a toast when session.create reports an error", async () => {
    await harness.send({ type: "mounted" })
    server.setSessionCreateStatus(500)

    await harness.send({ type: "send", text: "doomed prompt" })

    expect(server.prompts).toHaveLength(0)
    expect(harness.posted.some((m) => m.type === "sessionIdle")).toBe(true)
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Send failed"))
  })

  it("posts sessionIdle and a toast when session.create throws (connection drop)", async () => {
    await harness.send({ type: "mounted" })
    server.setSessionCreateStatus(0)

    await harness.send({ type: "send", text: "doomed prompt" })

    expect(server.prompts).toHaveLength(0)
    expect(harness.posted.some((m) => m.type === "sessionIdle")).toBe(true)
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Send failed"))
  })

  it("posts sessionIdle alongside the disconnected banner when the backend cannot start", async () => {
    await harness.send({ type: "mounted" })
    vi.mocked(harness.servers.ensure).mockRejectedValue(new Error("spawn opencode ENOENT"))

    await harness.send({ type: "send", text: "doomed prompt" })

    expect(server.prompts).toHaveLength(0)
    expect(harness.posted.some((m) => m.type === "connected" && m.connected === false)).toBe(true)
    expect(harness.posted.some((m) => m.type === "sessionIdle")).toBe(true)
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Send failed"))
  })

  it("posts sessionIdle and a toast when a custom command's session.create fails", async () => {
    await harness.send({ type: "mounted" })
    server.setSessionCreateStatus(500)

    await harness.send({ type: "runCommand", command: "definitely-custom", arguments: "" })

    expect(server.commandCalls).toHaveLength(0)
    expect(harness.posted.some((m) => m.type === "sessionIdle")).toBe(true)
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Send failed"))
  })
})

describe("ChatView harness: builtin command failures", () => {
  // beginBuiltinTurn has already posted the bubble (webview busy) and recorded
  // a Main task by the time /compact's summarize call fails; failBuiltinTurn's
  // sessionIdle + settle is the only thing that recovers either, because a
  // turn that never started produces no SSE events.

  beforeEach(() => {
    vi.mocked(vscode.window.showErrorMessage).mockClear()
  })

  // One settled turn so /compact has a session to run against.
  async function completeTurn(): Promise<void> {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "original prompt" })
    server.push({ type: "message.updated", info: { id: "usr_1", role: "user", sessionID: SESSION_ID } })
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION_ID } })
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION_ID, finish: "stop" } })
    server.push({ type: "session.idle", sessionID: SESSION_ID })
    await until(() => harness.posted.some((m) => m.type === "sessionIdle"))
  }

  function idleCount(): number {
    return harness.posted.filter((m) => m.type === "sessionIdle").length
  }

  it("unbricks the composer and settles the Main task when /compact's summarize reports an error", async () => {
    await completeTurn()
    server.setSummarizeStatus(500)
    const before = idleCount()

    await harness.send({ type: "runCommand", command: "compact", arguments: "" })

    expect(idleCount()).toBe(before + 1)
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Command failed"))
    await until(() => {
      const mains = harness.taskStore.list().filter((t) => t.kind === "main")
      return mains.some((t) => t.status === "error") && mains.every((t) => t.status !== "running")
    })
  })

  it("unbricks the composer when the summarize call throws (connection drop)", async () => {
    await completeTurn()
    server.setSummarizeStatus(0)
    const before = idleCount()

    await harness.send({ type: "runCommand", command: "compact", arguments: "" })

    expect(idleCount()).toBe(before + 1)
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Command failed"))
  })
})

describe("ChatView harness: compaction summary turns", () => {
  it("forwards opencode's summary flag to the webview and persists it", async () => {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "please compact" })

    server.push({ type: "message.updated", info: { id: "usr_1", role: "user", sessionID: SESSION_ID } })
    server.push({ type: "message.updated", info: { id: "msg_s", role: "assistant", sessionID: SESSION_ID, summary: true } })
    server.push({
      type: "message.part.updated",
      part: { id: "part_1", messageID: "msg_s", sessionID: SESSION_ID, type: "text", text: "anchored summary" },
    })
    server.push({ type: "message.updated", info: { id: "msg_s", role: "assistant", sessionID: SESSION_ID, summary: true, finish: "stop" } })
    server.push({ type: "session.idle", sessionID: SESSION_ID })
    await until(() => harness.posted.some((m) => m.type === "sessionIdle"))

    expect(harness.posted.some((m) => m.type === "assistantSummary" && m.id === "a_msg_s")).toBe(true)

    await harness.chatView.flushPersist()
    const [active] = savedConversations()
    const assistant = active!.messages[1]!
    expect(assistant.role).toBe("assistant")
    expect(assistant.summary).toBe(true)
    expect(assistant.pending).toBe(false)
  })
})
