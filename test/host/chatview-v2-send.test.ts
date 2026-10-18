import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as vscode from "vscode"
import { createV2Api } from "../../src/backend/v2/api"
import { startMockOpencodeV2, type MockOpencodeV2 } from "./mock-opencode-v2-server"
import { ChatView } from "../../src/chat/view"
import { AgentTaskStore } from "../../src/agents/task-store"
import type { Backend, ServerManager } from "../../src/server"
import type { Preferences } from "../../src/preferences"
import type { RecentEditsTracker } from "../../src/workspace-context/recent-edits"
import type { IndexManager } from "../../src/indexing/index-manager"
import type { Inbound, Outbound } from "../../src/protocol"

// Full send round-trip against the mock opencode 2.0 server: 2.0 never
// reports the created user message over SSE, so the view must resolve the
// pending bubble from the prompt route's inbox id — otherwise undo/redo and
// edit never find a settled turn ("Nothing to undo").

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
    onDidDispose: () => ({ dispose: vi.fn() }),
    onDidChangeVisibility: () => ({ dispose: vi.fn() }),
    visible: true,
    badge: undefined as { value: number; tooltip: string } | undefined,
    show: vi.fn(),
  }
  return {
    view: view as unknown as vscode.WebviewView,
    posted,
    send: (msg: Inbound) => Promise.resolve(receive?.(msg)),
  }
}

let server: MockOpencodeV2
let posted: Outbound[] = []
let send: (msg: Inbound) => Promise<unknown>
let chatView: ChatView

beforeEach(async () => {
  server = await startMockOpencodeV2()
  server.sessions = []
  const backend = {
    url: server.url,
    api: createV2Api({ url: server.url, directory: "/ws", password: server.password }),
    directory: "/ws",
  } as unknown as Backend
  const servers = {
    ensure: vi.fn(async () => backend),
    currentWorkspace: vi.fn(() => undefined),
    currentBackend: vi.fn(() => backend),
  } as unknown as ServerManager
  const prefs = {
    get: () => ({}),
    onChange: vi.fn(() => ({ dispose: vi.fn() })),
    recentModels: () => [] as string[],
    variantFor: () => undefined,
    setModel: vi.fn(async () => {}),
    setAgent: vi.fn(async () => {}),
    collapsedProviders: () => [] as string[],
    setProviderCollapsed: vi.fn(async () => {}),
  } as unknown as Preferences
  const indexManager = {
    onStatusChange: vi.fn(() => ({ dispose: vi.fn() })),
    currentStatus: vi.fn(() => ({ state: "disabled" })),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as IndexManager
  const context = {
    workspaceState: makeMemento(),
    globalState: makeMemento(),
    extensionUri: vscode.Uri.file("/ext"),
    storageUri: vscode.Uri.file("/storage"),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext
  const taskStore = new AgentTaskStore(makeMemento() as unknown as vscode.Memento)
  chatView = new ChatView(context, servers, prefs, {} as RecentEditsTracker, indexManager, taskStore)
  const fake = makeFakeWebviewView()
  await chatView.resolveWebviewView(fake.view)
  posted = fake.posted
  send = fake.send
})

afterEach(async () => {
  await server.close()
})

async function until(cond: () => boolean, ms = 4000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("ChatView on opencode 2.0: user message association", () => {
  it("resolves the pending bubble from the prompt inbox id without any SSE user event", async () => {
    await send({ type: "mounted" })
    await send({ type: "send", text: "hello there" })

    const userMsg = posted.find((m) => m.type === "userMessage")
    expect(userMsg && "text" in userMsg ? userMsg.text : undefined).toBe("hello there")
    const userID = userMsg && "id" in userMsg ? userMsg.id : ""

    await until(() =>
      posted.some((m) => m.type === "userMessageBackendID" && "id" in m && m.id === userID),
    )
    const assoc = posted.find((m) => m.type === "userMessageBackendID")
    expect(assoc && "backendID" in assoc ? assoc.backendID : undefined).toMatch(/^inbox_/)
  })

  it("undo reverts the settled turn and redo restores it", async () => {
    await send({ type: "mounted" })
    await send({ type: "send", text: "hello there" })
    await until(() => posted.some((m) => m.type === "userMessageBackendID"))

    await send({ type: "runCommand", command: "undo", arguments: "" })
    await until(() => posted.some((m) => m.type === "setComposerText"))
    // The undone prompt is restored to the composer for editing and resend.
    expect(posted).toContainEqual({ type: "setComposerText", text: "hello there" })
    const restores = posted.filter((m) => m.type === "restore")
    const lastRestore = restores[restores.length - 1]!
    expect(lastRestore && "messages" in lastRestore ? lastRestore.messages : undefined).toEqual([])

    await send({ type: "runCommand", command: "redo", arguments: "" })
    await until(() =>
      posted.some(
        (m) => m.type === "restore" && "messages" in m && m.messages.length === 1,
      ),
    )
  })
})
