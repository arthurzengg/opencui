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
    server.push({ type: "message.part.delta", sessionID: SESSION_ID, messageID: "msg_a", partID: "p2", field: "reasoning", delta: "R" })
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
