import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as vscode from "vscode"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { startMockOpencode, type MockOpencodeServer } from "./mock-opencode-server"
import { ChatView } from "../../src/chat/view"
import {
  ACTIVE_CONVERSATION_KEY,
  CONVERSATIONS_KEY,
  type SavedConversation,
} from "../../src/chat/conversation-store"
import { getOutputChannel } from "../../src/output"
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
    onDidChangeVisibility: (cb: () => void) => {
      visibilityCb = cb
      return { dispose: vi.fn() }
    },
    visible: true,
    badge: undefined as { value: number; tooltip: string } | undefined,
    show: vi.fn(),
  }
  let visibilityCb: (() => void) | undefined
  return {
    view: view as unknown as vscode.WebviewView,
    posted,
    // resolveWebviewView registers a callback that returns onMessage's
    // promise, so awaiting this awaits the full host-side handling.
    send: (msg: Inbound) => Promise.resolve(receive?.(msg)),
    disposeView: () => disposeCb?.(),
    setVisible: (visible: boolean) => {
      view.visible = visible
      visibilityCb?.()
    },
    badge: () => view.badge,
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
  setVisible: (visible: boolean) => void
  badge: () => { value: number; tooltip: string } | undefined
  workspaceState: Memento
  servers: ServerManager
  taskStore: AgentTaskStore
  prefs: Preferences
}

beforeEach(async () => {
  server = await startMockOpencode()
  const client = createOpencodeClient({ baseUrl: server.url })
  const backend = { url: server.url, client, directory: "/ws" } as unknown as Backend
  const servers = {
    ensure: vi.fn(async () => backend),
    currentWorkspace: vi.fn(() => undefined),
    currentBackend: vi.fn(() => backend),
  } as unknown as ServerManager
  const foldedProviders: string[] = []
  const prefs = {
    get: () => ({}),
    onChange: vi.fn(() => ({ dispose: vi.fn() })),
    recentModels: () => [] as string[],
    variantFor: () => undefined,
    setModel: vi.fn(async () => {}),
    setAgent: vi.fn(async () => {}),
    collapsedProviders: () => [...foldedProviders],
    setProviderCollapsed: vi.fn(async (id: string, collapsed: boolean) => {
      const idx = foldedProviders.indexOf(id)
      if (collapsed && idx < 0) foldedProviders.push(id)
      if (!collapsed && idx >= 0) foldedProviders.splice(idx, 1)
    }),
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
    storageUri: vscode.Uri.file("/storage"),
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
  harness = { chatView, posted: fake.posted, send: fake.send, disposeView: fake.disposeView, setVisible: fake.setVisible, badge: fake.badge, workspaceState, servers, taskStore, prefs }
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

describe("ChatView harness: openExternal", () => {
  it("routes an http(s) URL to vscode.env.openExternal", async () => {
    vi.mocked(vscode.env.openExternal).mockClear()
    await harness.send({ type: "openExternal", url: "https://example.com/docs" })
    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1)
    const uri = vi.mocked(vscode.env.openExternal).mock.calls[0]![0]
    expect(String(uri)).toContain("https://example.com/docs")
  })

  it("refuses non-http schemes at the trust boundary", async () => {
    vi.mocked(vscode.env.openExternal).mockClear()
    await harness.send({ type: "openExternal", url: "javascript:alert(1)" })
    await harness.send({ type: "openExternal", url: "file:///etc/passwd" })
    expect(vscode.env.openExternal).not.toHaveBeenCalled()
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

describe("ChatView harness: SSE re-attach mid-turn", () => {
  it("resumes the in-flight message in place: one row, text once, and that is what persists (#585)", async () => {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "hello there" })

    server.push({ type: "message.updated", info: { id: "usr_1", role: "user", sessionID: SESSION_ID } })
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION_ID } })
    server.push({
      type: "message.part.updated",
      part: { id: "part_1", messageID: "msg_a", sessionID: SESSION_ID, type: "text", text: "Hi" },
    })
    await until(() => harness.posted.some((m) => m.type === "textDelta"))

    // Transport drop: the view unsticks the composer and re-attaches to the
    // same (still running) session.
    server.dropClients()
    await until(() => harness.posted.some((m) => m.type === "sessionIdle"))
    await server.awaitClient()

    // opencode's end-of-part snapshot re-delivers the whole text; before
    // #585 the fresh subscription re-announced msg_a (second row, same id)
    // and re-emitted "Hi there" in full into both rows.
    server.push({
      type: "message.part.updated",
      part: { id: "part_1", messageID: "msg_a", sessionID: SESSION_ID, type: "text", text: "Hi there" },
    })
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION_ID, finish: "stop" } })
    await until(() => harness.posted.some((m) => m.type === "assistantDone" && m.id === "a_msg_a"))

    expect(harness.posted.filter((m) => m.type === "assistantStart" && m.id === "a_msg_a")).toHaveLength(1)
    const deltas = harness.posted.flatMap((m) => (m.type === "textDelta" ? [m.delta] : []))
    expect(deltas.join("")).toBe("Hi there")

    await harness.chatView.flushPersist()
    const assistants = savedConversations()[0]!.messages.filter((m) => m.role === "assistant")
    expect(assistants).toHaveLength(1)
    expect(assistants[0]!.blocks).toEqual([{ type: "text", text: "Hi there" }])
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

describe("ChatView harness: post-dispatch send failures", () => {
  // Unlike the pre-dispatch failures above, the session already exists here, so
  // recordMainTaskStart has recorded a "running" Main row by the time the
  // dispatch fails. Nothing else would ever settle it — a turn that never
  // started produces no session.idle — so the unstick path must, or the Agents
  // popover shows a phantom running agent forever.

  beforeEach(() => {
    vi.mocked(vscode.window.showErrorMessage).mockClear()
  })

  function mainTasks() {
    return harness.taskStore.list().filter((t) => t.kind === "main")
  }

  async function expectMainSettledAsError(): Promise<void> {
    await until(() => {
      const mains = mainTasks()
      return mains.length > 0 && mains.every((t) => t.status !== "running")
    })
    expect(mainTasks().some((t) => t.status === "error")).toBe(true)
  }

  it("settles the Main task when prompt_async reports an error", async () => {
    await harness.send({ type: "mounted" })
    server.setPromptStatus(500)

    await harness.send({ type: "send", text: "doomed prompt" })

    // The dispatch reached a real session — this is the post-recordMainTaskStart
    // path, not one of the pre-dispatch bails above.
    expect(server.prompts).toHaveLength(1)
    expect(harness.posted.some((m) => m.type === "sessionIdle")).toBe(true)
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Send failed"))
    await expectMainSettledAsError()
  })

  it("settles the Main task when the prompt call throws (connection drop)", async () => {
    await harness.send({ type: "mounted" })
    server.setPromptStatus(0)

    await harness.send({ type: "send", text: "doomed prompt" })

    expect(harness.posted.some((m) => m.type === "sessionIdle")).toBe(true)
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Send failed"))
    await expectMainSettledAsError()
  })

  it("settles the Main task when a custom command's dispatch reports an error", async () => {
    await harness.send({ type: "mounted" })
    server.setCommandStatus(500)

    await harness.send({ type: "runCommand", command: "definitely-custom", arguments: "" })

    expect(server.commandCalls).toHaveLength(1)
    expect(harness.posted.some((m) => m.type === "sessionIdle")).toBe(true)
    await expectMainSettledAsError()
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

describe("ChatView harness: attachment storage", () => {
  const fsFiles = (vscode as unknown as { __fsFiles: Map<string, Uint8Array> }).__fsFiles
  const PNG_BYTES = new Uint8Array([137, 80, 78, 71])
  const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64")

  /**
   * A ChatView over a pre-seeded workspaceState — the beforeEach harness
   * constructs before a test can seed, so restore/migration flows need
   * their own instance. Uses a per-test storage root to keep the shared
   * fs map from cross-contaminating tests.
   */
  async function freshChatView(seed: SavedConversation[], storageBase: string) {
    const workspaceState = makeMemento()
    await workspaceState.update(CONVERSATIONS_KEY, seed)
    await workspaceState.update(ACTIVE_CONVERSATION_KEY, seed[0]!.id)
    const context = {
      workspaceState,
      globalState: makeMemento(),
      extensionUri: vscode.Uri.file("/ext"),
      storageUri: vscode.Uri.file(storageBase),
      subscriptions: [],
    } as unknown as vscode.ExtensionContext
    const prefs = { get: () => ({}), onChange: vi.fn(() => ({ dispose: vi.fn() })) } as unknown as Preferences
    const indexManager = {
      onStatusChange: vi.fn(() => ({ dispose: vi.fn() })),
      currentStatus: vi.fn(() => ({ state: "disabled" })),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as IndexManager
    const chatView = new ChatView(
      context,
      harness.servers,
      prefs,
      {} as RecentEditsTracker,
      indexManager,
      new AgentTaskStore(makeMemento() as unknown as vscode.Memento),
    )
    const fake = makeFakeWebviewView()
    await chatView.resolveWebviewView(fake.view)
    return { chatView, posted: fake.posted, send: fake.send, disposeView: fake.disposeView, workspaceState }
  }

  function seededConversation(blocks: SavedConversation["messages"][number]["blocks"]): SavedConversation {
    return {
      id: "conv_seed",
      title: "seeded",
      createdAt: 1,
      updatedAt: 1,
      messages: [{ id: "u_seed", role: "user", blocks }],
    }
  }

  it("stores sent attachment bytes on disk, strips them from workspaceState, and points the prompt at the file", async () => {
    // fsFiles is shared across the file's tests; diff keys instead of
    // grabbing the first match so leftovers from other tests can't leak in.
    const preexisting = new Set(fsFiles.keys())
    await harness.send({ type: "mounted" })
    await harness.send({
      type: "send",
      text: "look at this screenshot",
      attachments: [
        // No sourcePath — the pasted-image case that used to ride as base64.
        { id: "att_1", mime: "image/png", filename: "shot.png", dataUrl: `data:image/png;base64,${PNG_B64}`, bytes: PNG_BYTES.byteLength },
      ],
    })
    await until(() => server.prompts.length === 1)

    // The prompt part references the stored file, not an inline data URL.
    const body = server.prompts[0]!.body as { parts: Array<{ type: string; url?: string }> }
    const filePart = body.parts.find((p) => p.type === "file")!
    expect(filePart.url).toMatch(/^file:\/\/\/storage\/attachments\/att_/)

    // The bytes landed in the store exactly once.
    const storedKey = [...fsFiles.keys()].find(
      (k) => !preexisting.has(k) && k.startsWith("file:///storage/attachments/"),
    )!
    expect(fsFiles.get(storedKey)).toEqual(PNG_BYTES)

    // The webview still received the preview data URL on the wire.
    const posted = harness.posted.find((m) => m.type === "userMessage")!
    expect("attachments" in posted && posted.attachments?.[0]?.dataUrl).toContain("base64")

    // Persistence carries the reference, never the base64.
    await harness.chatView.flushPersist()
    const active = savedConversations().find((c) => c.messages.length > 0)!
    const block = active.messages[0]!.blocks[0]!
    expect(block).toMatchObject({ type: "attachment", storageID: expect.stringMatching(/^att_/) })
    expect((block as { dataUrl?: string }).dataUrl).toBeUndefined()
  })

  it("re-inflates image previews from the store when restoring a conversation", async () => {
    fsFiles.set("file:///storeB/attachments/attseed1", PNG_BYTES)
    const fresh = await freshChatView(
      [seededConversation([
        { type: "attachment", mime: "image/png", filename: "pic.png", bytes: PNG_BYTES.byteLength, storageID: "attseed1" },
        { type: "text", text: "restored" },
      ])],
      "/storeB",
    )
    await fresh.send({ type: "mounted" })
    const restore = fresh.posted.find((m) => m.type === "restore")!
    const block = ("messages" in restore ? restore.messages : [])[0]!.blocks[0]!
    expect(block).toMatchObject({ type: "attachment", dataUrl: `data:image/png;base64,${PNG_B64}` })
    fresh.disposeView()
  })

  it("migrates legacy inline attachments to the store on mount", async () => {
    const fresh = await freshChatView(
      [seededConversation([
        { type: "attachment", mime: "application/pdf", filename: "doc.pdf", bytes: PNG_BYTES.byteLength, dataUrl: `data:application/pdf;base64,${PNG_B64}` },
        { type: "text", text: "legacy" },
      ])],
      "/storeC",
    )
    await fresh.send({ type: "mounted" })

    // In-memory (and the restore post) keeps the dataUrl for this session,
    // but gains the storage reference.
    const restore = fresh.posted.find((m) => m.type === "restore")!
    const restored = ("messages" in restore ? restore.messages : [])[0]!.blocks[0]! as {
      storageID?: string
      dataUrl?: string
    }
    expect(restored.storageID).toMatch(/^att_/)
    expect(restored.dataUrl).toContain("base64")

    // Persisted state is stripped, and the bytes are on disk.
    await fresh.chatView.flushPersist()
    const persisted = (fresh.workspaceState.get(CONVERSATIONS_KEY) as SavedConversation[])[0]!
    const block = persisted.messages[0]!.blocks[0]! as { storageID?: string; dataUrl?: string }
    expect(block.storageID).toBe(restored.storageID)
    expect(block.dataUrl).toBeUndefined()
    expect(fsFiles.get(`file:///storeC/attachments/${restored.storageID}`)).toEqual(PNG_BYTES)
    fresh.disposeView()
  })

  it("deletes now-unreferenced stored bytes when a conversation is deleted", async () => {
    const preexisting = new Set(fsFiles.keys())
    await harness.send({ type: "mounted" })
    await harness.send({
      type: "send",
      text: "attach then delete",
      attachments: [
        { id: "att_1", mime: "image/png", filename: "shot.png", dataUrl: `data:image/png;base64,${PNG_B64}`, bytes: PNG_BYTES.byteLength },
      ],
    })
    await until(() => server.prompts.length === 1)
    const storedKey = [...fsFiles.keys()].find(
      (k) => !preexisting.has(k) && k.startsWith("file:///storage/attachments/"),
    )
    expect(storedKey).toBeDefined()

    const activeID = harness.workspaceState.get(ACTIVE_CONVERSATION_KEY) as string
    await harness.send({ type: "deleteConversation", id: activeID })
    await until(() => !fsFiles.has(storedKey!))
  })
})

describe("ChatView harness: host-side delta coalescing", () => {
  it("batches token deltas into fewer posts, flushes before sessionIdle, and persists the full text", async () => {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "stream fast" })
    server.push({ type: "message.updated", info: { id: "usr_1", role: "user", sessionID: SESSION_ID } })
    for (const ch of ["a", "b", "c", "d", "e"]) {
      server.push({ type: "message.part.delta", sessionID: SESSION_ID, messageID: "msg_a", partID: "p1", field: "text", delta: ch })
    }
    server.push({ type: "message.part.updated", part: { id: "p2", messageID: "msg_a", sessionID: SESSION_ID, type: "reasoning", text: "" } })
    server.push({ type: "message.part.delta", sessionID: SESSION_ID, messageID: "msg_a", partID: "p2", field: "text", delta: "R" })
    server.push({ type: "session.idle", sessionID: SESSION_ID })
    await until(() => harness.posted.some((m) => m.type === "sessionIdle"))

    const textDeltas = harness.posted.filter((m) => m.type === "textDelta")
    expect(textDeltas.map((d) => ("delta" in d ? d.delta : "")).join("")).toBe("abcde")
    // Five tokens arrive inside one 25 ms window; the invariant that matters
    // is "fewer posts than tokens", not an exact batch count.
    expect(textDeltas.length).toBeLessThan(5)
    const reasoningDeltas = harness.posted.filter((m) => m.type === "reasoningDelta")
    expect(reasoningDeltas.map((d) => ("delta" in d ? d.delta : "")).join("")).toBe("R")

    // sessionIdle flushed the buffer before itself — buffered text can never
    // be overtaken by a later event.
    const types = harness.posted.map((m) => m.type)
    expect(types.lastIndexOf("textDelta")).toBeLessThan(types.indexOf("sessionIdle"))

    await harness.chatView.flushPersist()
    const [active] = savedConversations()
    const assistant = active!.messages[1]!
    expect(assistant.blocks).toContainEqual({ type: "text", text: "abcde" })
    expect(assistant.blocks).toContainEqual({ type: "reasoning", text: "R" })
  })

  it("no longer logs a line per token delta", async () => {
    const appendLine = getOutputChannel().appendLine as unknown as ReturnType<typeof vi.fn>
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "quiet stream" })
    appendLine.mockClear()
    server.push({ type: "message.part.delta", sessionID: SESSION_ID, messageID: "msg_a", partID: "p1", field: "text", delta: "x" })
    server.push({ type: "session.idle", sessionID: SESSION_ID })
    await until(() => harness.posted.some((m) => m.type === "sessionIdle"))

    const lines = appendLine.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes("[sse] message.part.delta"))).toBe(false)
    expect(lines.some((l) => l.includes("[sse] session.idle"))).toBe(true)
  })
})

describe("ChatView harness: review-hunk sync debounce", () => {
  function editToolEvent(callID: string, status: "running" | "completed", filePath: string) {
    return {
      type: "message.part.updated",
      part: {
        id: `part_${callID}`,
        messageID: "msg_a",
        sessionID: SESSION_ID,
        type: "tool",
        callID,
        tool: "edit",
        state: {
          status,
          input: { filePath },
          ...(status === "completed"
            ? { metadata: { filediff: { patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1 } } }
            : {}),
        },
      },
    }
  }

  async function startAssistantTurn(prompt: string) {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: prompt })
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION_ID } })
    await until(() => harness.posted.some((m) => m.type === "assistantStart"))
  }

  // The send pipeline stats other paths (context collectors), so counts are
  // filtered to the test's own file rather than cleared globally.
  function statCallsFor(name: string) {
    return vi
      .mocked(vscode.workspace.fs.stat)
      .mock.calls.filter((c) => String((c[0] as vscode.Uri | undefined)?.fsPath ?? c[0]).includes(name))
      .length
  }

  it("coalesces a burst of completed tool closures into one hunk-sync pass", async () => {
    await startAssistantTurn("edit a file five times")
    for (let i = 0; i < 5; i++) server.push(editToolEvent(`call_${i}`, "completed", "src/burst.ts"))

    // Each sync pass stats the changed path exactly once (the default fs.stat
    // mock resolves, so the first workspace candidate wins and nothing gets
    // purged or re-queued). Five closures inside one debounce window must
    // collapse to one pass — allow two in case a closure straddles the timer.
    await until(() => statCallsFor("burst.ts") > 0)
    await new Promise((r) => setTimeout(r, 250))
    expect(statCallsFor("burst.ts")).toBeLessThanOrEqual(2)
  })

  it("does not run the sync for non-completed tool ticks", async () => {
    await startAssistantTurn("edit a file")
    // Seed one completed change, then wait for its debounced pass: with a
    // change present, a sync pass — if one were wrongly queued later — would
    // stat this path again.
    server.push(editToolEvent("call_seed", "completed", "src/seed.ts"))
    await until(() => statCallsFor("seed.ts") === 1)

    for (let i = 0; i < 3; i++) server.push(editToolEvent(`call_run_${i}`, "running", "src/seed.ts"))
    await new Promise((r) => setTimeout(r, 250))
    expect(statCallsFor("seed.ts")).toBe(1)
  })
})

describe("ChatView harness: waiting-for-input Main status", () => {
  function lastMainStatus() {
    return harness.taskStore
      .list()
      .filter((t) => t.kind === "main")
      .at(-1)?.status
  }

  it("flips the Main row to waiting on permission.updated and back to running on reply", async () => {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "guarded edit" })

    server.push({ type: "permission.updated", id: "perm_1", sessionID: SESSION_ID, title: "Edit file" })
    await until(() => lastMainStatus() === "waiting")
    const snap = harness.posted.filter((m) => m.type === "agentsStatus").at(-1)
    expect(snap && "status" in snap ? snap.status.waiting : 0).toBe(1)

    await harness.send({ type: "permissionReply", id: "perm_1", response: "once" })
    await until(() => lastMainStatus() === "running")
  })

  it("Stop clears pending prompts so the next turn cannot wedge on waiting", async () => {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "first try" })
    server.push({ type: "permission.updated", id: "perm_stale", sessionID: SESSION_ID, title: "T" })
    await until(() => lastMainStatus() === "waiting")

    await harness.send({ type: "abort" })
    server.push({ type: "session.idle", sessionID: SESSION_ID })
    await until(() => harness.posted.some((m) => m.type === "sessionIdle"))

    await harness.send({ type: "send", text: "second try" })
    server.push({ type: "permission.updated", id: "perm_2", sessionID: SESSION_ID, title: "T2" })
    await until(() => lastMainStatus() === "waiting")
    await harness.send({ type: "permissionReply", id: "perm_2", response: "once" })
    // Without the abort-time map clear, perm_stale would keep the pending
    // count above zero and the row would stay `waiting` forever.
    await until(() => lastMainStatus() === "running")
  })

  it("a permission answered outside the panel releases the row and dismisses the dialog", async () => {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "guarded edit" })

    server.push({ type: "permission.updated", id: "perm_ext", sessionID: SESSION_ID, title: "Edit file" })
    await until(() => lastMainStatus() === "waiting")

    // Nobody sent `permissionReply` — this is opencode reporting that something
    // else (a plugin, an `always` rule) answered. `permission.replied` keys the
    // permission as `permissionID`, not `id`.
    server.push({ type: "permission.replied", sessionID: SESSION_ID, permissionID: "perm_ext", response: "once" })
    await until(() => lastMainStatus() === "running")
    await until(() => harness.posted.some((m) => m.type === "permissionResolved" && m.id === "perm_ext"))
  })

  it("ignores a reply for another session", async () => {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "guarded edit" })

    server.push({ type: "permission.updated", id: "perm_mine", sessionID: SESSION_ID, title: "Edit file" })
    await until(() => lastMainStatus() === "waiting")

    server.push({ type: "permission.replied", sessionID: "ses_other", permissionID: "perm_mine", response: "once" })
    await new Promise((r) => setTimeout(r, 50))
    expect(lastMainStatus()).toBe("waiting")
    expect(harness.posted.some((m) => m.type === "permissionResolved")).toBe(false)
  })

  it("routes the opencode >=1.18 shapes: permission.asked and a requestID-keyed reply", async () => {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "guarded edit" })

    // 1.18 renamed the ask event and dropped `title`; the request carries
    // `permission` + `patterns` instead (#520).
    server.push({
      type: "permission.asked",
      id: "perm_v2",
      sessionID: SESSION_ID,
      permission: "external_directory",
      patterns: ["/outside/*"],
      always: ["/outside/*"],
      tool: { messageID: "msg_1", callID: "call_1" },
    })
    await until(() => lastMainStatus() === "waiting")
    const dialog = harness.posted.find((m) => m.type === "permission" && m.id === "perm_v2")
    expect(dialog && "title" in dialog ? dialog.title : "").toContain("external_directory")

    // 1.18 replies key the permission `requestID` and the answer `reply`.
    server.push({ type: "permission.replied", sessionID: SESSION_ID, requestID: "perm_v2", reply: "once" })
    await until(() => lastMainStatus() === "running")
    await until(() => harness.posted.some((m) => m.type === "permissionResolved" && m.id === "perm_v2"))
  })
})

describe("ChatView harness: errored Main task clears on next turn", () => {
  it("keeps the error row visible until the next send, then drops it", async () => {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "first try" })
    // A parent session.error (e.g. unsupported model) settles the Main row
    // to error; the trailing idle's sweep must not resurrect or clear it.
    server.push({ type: "session.error", sessionID: SESSION_ID, error: { data: { message: "rate limit exceeded" } } })
    server.push({ type: "session.idle", sessionID: SESSION_ID })
    await until(() => harness.taskStore.list().some((t) => t.status === "error"))
    await until(() => harness.posted.some((m) => m.type === "sessionIdle"))

    await harness.send({ type: "send", text: "second try" })
    await until(() => harness.taskStore.list().every((t) => t.status !== "error"))
    const mains = harness.taskStore.list().filter((t) => t.kind === "main")
    expect(mains).toHaveLength(1)
    expect(mains[0]!.status).toBe("running")
    expect(mains[0]!.title).toContain("second try")
  })
})

describe("ChatView harness: stale-row reconcile on conversation entry", () => {
  it("settles a ghost running row when re-entering a conversation whose session ended", async () => {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "start a turn" })
    await until(() => harness.taskStore.list().some((t) => t.kind === "main" && t.status === "running"))
    const ghostConvID = harness.chatView.activeConversationID()

    // Switch away mid-turn: this aborts the SSE subscription but not the
    // server-side turn, so the Main row stays running with nothing left
    // to settle it — the audit's ghost-row scenario.
    await harness.send({ type: "createConversation" })
    expect(harness.taskStore.list().some((t) => t.status === "running")).toBe(true)

    // By the time the user returns, the abandoned turn has ended.
    server.setSessionStatus(SESSION_ID, { type: "idle" })
    await harness.send({ type: "openConversation", id: ghostConvID })
    await until(() =>
      harness.taskStore.list().every((t) => t.status !== "running" && t.status !== "waiting"),
    )
  })

  it("leaves rows running when the abandoned session is still busy server-side", async () => {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "long turn" })
    await until(() => harness.taskStore.list().some((t) => t.kind === "main" && t.status === "running"))
    const ghostConvID = harness.chatView.activeConversationID()
    await harness.send({ type: "createConversation" })

    // A child row too: the still-busy branch re-registers the child into
    // the entry-reconcile's no-op subscription — pin that this leaves the
    // row alone instead of crashing or settling it.
    await harness.taskStore.upsert({
      id: "subagent:child:ses_child_ghost",
      kind: "subagent",
      conversationID: ghostConvID,
      sessionID: SESSION_ID,
      childSessionID: "ses_child_ghost",
      title: "Ghost child",
      status: "running",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    })
    server.setSessionStatus(SESSION_ID, { type: "busy" })
    server.setSessionStatus("ses_child_ghost", { type: "busy" })

    const pollsBefore = server.statusPollCount()
    await harness.send({ type: "openConversation", id: ghostConvID })
    await until(() => server.statusPollCount() > pollsBefore)
    await new Promise((r) => setTimeout(r, 50))
    const rows = harness.taskStore.list().filter((t) => t.conversationID === ghostConvID)
    expect(rows.some((t) => t.kind === "main" && t.status === "running")).toBe(true)
    expect(rows.find((t) => t.id === "subagent:child:ses_child_ghost")!.status).toBe("running")
  })
})

describe("ChatView harness: webview HTML", () => {
  it("injects the grammars base URI and lets connect-src reach it", async () => {
    const fsFiles = (vscode as unknown as { __fsFiles: Map<string, Uint8Array> }).__fsFiles
    const key = "file:///ext/dist/webview/index.html"
    fsFiles.set(key, new TextEncoder().encode("<!doctype html><html><head></head><body></body></html>"))
    try {
      const fake = makeFakeWebviewView()
      await harness.chatView.resolveWebviewView(fake.view)
      const html = (fake.view.webview as { html?: string }).html ?? ""
      // The webview fetches dist/webview/grammars/*.json lazily; both halves —
      // the injected base and the CSP allowance — must survive edits together.
      expect(html).toContain('window.__opencuiGrammarsBase="file:///ext/dist/webview/grammars"')
      expect(html).toContain("connect-src vscode-resource: data: blob:")
    } finally {
      fsFiles.delete(key)
    }
  })
})

describe("ChatView harness: model catalog", () => {
  const GPT_PROVIDER = {
    id: "openai",
    name: "OpenAI",
    models: { "gpt-5.5": { variants: { low: {}, high: {} } } },
  }

  function catalogs() {
    return harness.posted.filter((m) => m.type === "modelCatalog")
  }

  it("pushes the model catalog after the mounted handshake", async () => {
    server.setProviders([GPT_PROVIDER])
    await harness.send({ type: "mounted" })
    await until(() => catalogs().length > 0)
    const msg = catalogs()[0]!
    expect(msg.type === "modelCatalog" && msg.catalog).toEqual({
      models: [
        {
          providerID: "openai",
          modelID: "gpt-5.5",
          providerName: "OpenAI",
          variants: ["low", "high"],
          lastVariant: undefined,
        },
      ],
      recents: [],
      collapsedProviders: [],
      agents: [{ name: "default" }],
    })
  })

  it("refreshModels refetches the provider list and re-pushes the catalog", async () => {
    await harness.send({ type: "mounted" })
    await until(() => catalogs().length > 0)
    server.setProviders([GPT_PROVIDER])
    await harness.send({ type: "refreshModels" })
    await until(() =>
      catalogs().some(
        (m) => m.type === "modelCatalog" && m.catalog.models.some((e) => e.modelID === "gpt-5.5"),
      ),
    )
  })

  it("setProviderCollapsed persists without an echo and rides the next catalog push", async () => {
    server.setProviders([GPT_PROVIDER])
    await harness.send({ type: "mounted" })
    await until(() => catalogs().length > 0)
    const before = catalogs().length
    await harness.send({ type: "setProviderCollapsed", providerID: "openai", collapsed: true })
    expect(catalogs().length).toBe(before)
    await harness.send({ type: "refreshModels" })
    await until(() => catalogs().length > before)
    const last = catalogs()[catalogs().length - 1]!
    expect(last.type === "modelCatalog" && last.catalog.collapsedProviders).toEqual(["openai"])
  })

  it("setModel persists via prefs; the variant is validated against the live catalog", async () => {
    server.setProviders([GPT_PROVIDER])
    await harness.send({ type: "mounted" })
    await until(() => catalogs().length > 0)
    const setModel = vi.mocked(harness.prefs.setModel)

    await harness.send({ type: "setModel", providerID: "openai", modelID: "gpt-5.5", variant: "high" })
    expect(setModel).toHaveBeenLastCalledWith("openai", "gpt-5.5", "high")

    // Stale variant from a changed config must not persist.
    await harness.send({ type: "setModel", providerID: "openai", modelID: "gpt-5.5", variant: "bogus" })
    expect(setModel).toHaveBeenLastCalledWith("openai", "gpt-5.5", undefined)

    // All-undefined = reset to the opencode default.
    await harness.send({ type: "setModel" })
    expect(setModel).toHaveBeenLastCalledWith(undefined, undefined, undefined)
  })

  it("the catalog carries user-selectable agents only; setAgent persists via prefs", async () => {
    // Deliberately unsorted: the catalog must come back alphabetical, not in
    // the server's config-discovery order.
    server.setAgents([
      { name: "plan", mode: "primary" },
      { name: "build", mode: "primary", description: "makes changes" },
      { name: "explore", mode: "subagent" },
      { name: "title", mode: "primary" }, // internal — filtered by name
    ])
    await harness.send({ type: "mounted" })
    await until(() =>
      catalogs().some(
        (m) => m.type === "modelCatalog" && m.catalog.agents.some((a) => a.name === "build"),
      ),
    )
    const last = catalogs().at(-1)!
    expect(last.type === "modelCatalog" && last.catalog.agents).toEqual([
      { name: "build", description: "makes changes" },
      { name: "plan" },
    ])

    const setAgent = vi.mocked(harness.prefs.setAgent)
    await harness.send({ type: "setAgent", name: "plan" })
    expect(setAgent).toHaveBeenLastCalledWith("plan")

    // No name = reset to the opencode default agent.
    await harness.send({ type: "setAgent" })
    expect(setAgent).toHaveBeenLastCalledWith(undefined)
  })
})

describe("ChatView harness: external session interop", () => {
  it("lists top-level unbound server sessions and adopts one on importSession", async () => {
    server.setSessions([
      { id: "ses_tui", title: "TUI refactor", time: { created: 1, updated: 2000 } },
      { id: "ses_kid", parentID: "ses_tui", title: "subagent", time: { updated: 3000 } },
    ])
    server.setSessionMessages("ses_tui", [
      { info: { id: "msg_u1", role: "user", sessionID: "ses_tui" }, parts: [{ type: "text", text: "refactor this" }] },
      {
        info: { id: "msg_a1", role: "assistant", sessionID: "ses_tui" },
        parts: [
          {
            type: "tool",
            callID: "call_1",
            tool: "edit",
            state: { status: "completed", title: "edit", input: { filePath: "/ws/a.ts" }, output: "ok" },
          },
          { type: "text", text: "done" },
        ],
      },
    ])
    await harness.send({ type: "mounted" })

    // The mounted handshake fetches the session list; the child session and
    // (later) bound sessions never reach the wire.
    await until(() =>
      harness.posted.some(
        (m) => m.type === "conversations" && (m.external ?? []).some((s) => s.id === "ses_tui"),
      ),
    )
    const withExternal = harness.posted.filter((m) => m.type === "conversations" && m.external?.length)
    const external = withExternal.at(-1)!.type === "conversations" ? withExternal.at(-1)!.external : undefined
    expect(external).toEqual([{ id: "ses_tui", title: "TUI refactor", updatedAt: 2000 }])

    await harness.send({ type: "importSession", sessionID: "ses_tui" })

    // Adopted: a saved conversation bound to the session, transcript rebuilt.
    const adopted = savedConversations().find((c) => c.sessionID === "ses_tui")
    expect(adopted).toBeDefined()
    expect(adopted!.title).toBe("TUI refactor")
    expect(adopted!.messages.map((m) => m.id)).toEqual(["msg_u1", "msg_a1"])
    expect(adopted!.messages[1]!.blocks.map((b) => b.type)).toEqual(["tool", "text"])
    expect(harness.chatView.activeConversationID()).toBe(adopted!.id)

    // The restore post carries the rebuilt transcript to the webview.
    const restore = harness.posted.filter((m) => m.type === "restore").at(-1)!
    expect(restore.type === "restore" && restore.messages.map((m) => m.id)).toEqual(["msg_u1", "msg_a1"])

    // Once bound, the session drops out of the external section.
    const lastConversations = harness.posted.filter((m) => m.type === "conversations").at(-1)!
    expect(lastConversations.type === "conversations" && lastConversations.external).toEqual([])
  })

  it("importSession for an already-bound session opens the existing conversation", async () => {
    server.setSessions([{ id: "ses_tui", title: "TUI chat", time: { updated: 10 } }])
    server.setSessionMessages("ses_tui", [
      { info: { id: "msg_u1", role: "user", sessionID: "ses_tui" }, parts: [{ type: "text", text: "hi" }] },
    ])
    await harness.send({ type: "mounted" })
    await harness.send({ type: "importSession", sessionID: "ses_tui" })
    const first = savedConversations().filter((c) => c.sessionID === "ses_tui")
    expect(first).toHaveLength(1)

    // Switch away, then import the same session again — no duplicate.
    await harness.send({ type: "createConversation" })
    await harness.send({ type: "importSession", sessionID: "ses_tui" })
    const again = savedConversations().filter((c) => c.sessionID === "ses_tui")
    expect(again).toHaveLength(1)
    expect(harness.chatView.activeConversationID()).toBe(again[0]!.id)
  })

  it("refreshSessions re-fetches the list on demand", async () => {
    await harness.send({ type: "mounted" })
    server.setSessions([{ id: "ses_late", title: "Started after mount", time: { updated: 99 } }])
    await harness.send({ type: "refreshSessions" })
    await until(() =>
      harness.posted.some(
        (m) => m.type === "conversations" && (m.external ?? []).some((s) => s.id === "ses_late"),
      ),
    )
  })
})

describe("ChatView harness: hidden-panel attention", () => {
  it("a permission arriving while hidden badges the container and toasts once", async () => {
    const toast = vi.mocked(vscode.window.showInformationMessage)
    toast.mockClear()
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "guarded edit" })
    harness.setVisible(false)

    server.push({ type: "permission.updated", id: "perm_1", sessionID: SESSION_ID, title: "Edit file" })
    await until(() => harness.badge()?.value === 1)
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("Edit file"), "Open Panel")

    // A second pending request bumps the badge but does not stack toasts.
    server.push({ type: "permission.updated", id: "perm_2", sessionID: SESSION_ID, title: "Run command" })
    await until(() => harness.badge()?.value === 2)
    expect(toast).toHaveBeenCalledTimes(1)

    // Answering one outside the panel drops the count.
    server.push({ type: "permission.replied", sessionID: SESSION_ID, permissionID: "perm_1", response: "once" })
    await until(() => harness.badge()?.value === 1)

    // Revealing the panel clears the badge — the dialog is the affordance now.
    harness.setVisible(true)
    expect(harness.badge()).toBeUndefined()

    // Hidden again: a fresh hidden stretch may toast again.
    harness.setVisible(false)
    server.push({ type: "permission.updated", id: "perm_3", sessionID: SESSION_ID, title: "Third ask" })
    await until(() => toast.mock.calls.length === 2)
  })

  it("no badge or toast while the panel is visible", async () => {
    const toast = vi.mocked(vscode.window.showInformationMessage)
    toast.mockClear()
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "guarded edit" })

    server.push({ type: "permission.updated", id: "perm_v", sessionID: SESSION_ID, title: "Edit file" })
    await until(() => harness.posted.some((m) => m.type === "permission" && m.id === "perm_v"))
    expect(harness.badge()).toBeUndefined()
    expect(toast).not.toHaveBeenCalled()
  })

  it("a question arriving while hidden badges too, and abort clears it", async () => {
    const toast = vi.mocked(vscode.window.showInformationMessage)
    toast.mockClear()
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "do the thing" })
    harness.setVisible(false)

    server.push({
      type: "question.asked",
      id: "q_1",
      sessionID: SESSION_ID,
      questions: [{ question: "Which flavor?", options: [{ label: "a" }, { label: "b" }] }],
    })
    await until(() => harness.badge()?.value === 1)
    expect(toast).toHaveBeenCalledTimes(1)

    await harness.send({ type: "abort" })
    expect(harness.badge()).toBeUndefined()
  })
})

describe("ChatView harness: reasoning parts stay out of the answer (#591)", () => {
  it("a DeepSeek-shaped turn persists thinking and answer as separate blocks", async () => {
    await harness.send({ type: "mounted" })
    await harness.send({ type: "send", text: "think first" })
    server.push({ type: "message.updated", info: { id: "usr_1", role: "user", sessionID: SESSION_ID } })
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION_ID } })
    const part = (id: string, type: "text" | "reasoning", text: string) => ({
      type: "message.part.updated",
      part: { id, messageID: "msg_a", sessionID: SESSION_ID, type, text },
    })
    const delta = (partID: string, delta: string) => ({
      type: "message.part.delta",
      sessionID: SESSION_ID,
      messageID: "msg_a",
      partID,
      field: "text",
      delta,
    })
    server.push(part("p_think", "reasoning", ""))
    server.push(delta("p_think", "Let me "))
    server.push(delta("p_think", "think."))
    server.push(part("p_think", "reasoning", "Let me think."))
    server.push(part("p_text", "text", ""))
    server.push(delta("p_text", "Hel"))
    server.push(delta("p_text", "lo"))
    server.push(part("p_text", "text", "Hello"))
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION_ID, finish: "stop" } })
    server.push({ type: "session.idle", sessionID: SESSION_ID })
    await until(() => harness.posted.some((m) => m.type === "sessionIdle"))

    const joined = (type: "textDelta" | "reasoningDelta") =>
      harness.posted.filter((m) => m.type === type).map((d) => ("delta" in d ? d.delta : "")).join("")
    expect(joined("reasoningDelta")).toBe("Let me think.")
    expect(joined("textDelta")).toBe("Hello")

    await harness.chatView.flushPersist()
    const [active] = savedConversations()
    expect(active!.messages[1]!.blocks).toEqual([
      { type: "reasoning", text: "Let me think." },
      { type: "text", text: "Hello" },
    ])
  })
})
