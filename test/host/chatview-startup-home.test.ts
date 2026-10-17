import { describe, it, expect, afterEach, vi } from "vitest"
import * as vscode from "vscode"
import { ChatView } from "../../src/chat/view"
import {
  ACTIVE_CONVERSATION_KEY,
  CONVERSATIONS_KEY,
  type SavedConversation,
} from "../../src/chat/conversation-store"
import type { Preferences } from "../../src/preferences"
import type { RecentEditsTracker } from "../../src/workspace-context/recent-edits"
import type { IndexManager } from "../../src/indexing/index-manager"
import type { ServerManager } from "../../src/server"
import type { Inbound, Outbound } from "../../src/protocol"

// Startup snapshot: by default the panel opens on the home view (an empty
// conversation, no restore); `opencui.chat.restoreLastSession` opts back
// into restoring the last chat.

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

function seeded(): SavedConversation {
  return {
    id: "conv_seed",
    title: "seeded chat",
    createdAt: 1,
    updatedAt: 1,
    messages: [{ id: "u_seed", role: "user", blocks: [{ type: "text", text: "hello" }] }],
  } as unknown as SavedConversation
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

describe("ChatView startup snapshot", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("defaults to the home view instead of restoring the last chat", async () => {
    const seed = [seeded()]
    const workspaceState = makeMemento()
    await workspaceState.update(CONVERSATIONS_KEY, seed)
    await workspaceState.update(ACTIVE_CONVERSATION_KEY, seed[0]!.id)
    const context = {
      workspaceState,
      globalState: makeMemento(),
      extensionUri: vscode.Uri.file("/ext"),
      storageUri: vscode.Uri.file("/storage"),
      subscriptions: [],
    } as unknown as vscode.ExtensionContext
    const servers = {
      ensure: vi.fn(async () => {
        throw new Error("no backend in startup test")
      }),
      currentBackend: vi.fn(() => undefined),
    } as unknown as ServerManager
    const prefs = { get: () => ({}), onChange: vi.fn(() => ({ dispose: vi.fn() })) } as unknown as Preferences
    const indexManager = {
      onStatusChange: vi.fn(() => ({ dispose: vi.fn() })),
      currentStatus: vi.fn(() => ({ state: "disabled" })),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as IndexManager
    // Default mock: getConfiguration().get() returns undefined → restore off.
    const chatView = new ChatView(context, servers, prefs, {} as RecentEditsTracker, indexManager, undefined)
    const fake = makeFakeWebviewView()
    await chatView.resolveWebviewView(fake.view)
    await fake.send({ type: "mounted" })
    const restore = fake.posted.find((m) => m.type === "restore")!
    expect("messages" in restore && restore.messages).toHaveLength(0)
    // The seeded chat is still listed for the home view.
    const list = fake.posted.find((m) => m.type === "conversations")!
    expect("conversations" in list && list.conversations.some((c) => c.id === "conv_seed")).toBe(true)
  })

  it("restores the last chat when opencui.chat.restoreLastSession is on", async () => {
    const seed = [seeded()]
    const workspaceState = makeMemento()
    await workspaceState.update(CONVERSATIONS_KEY, seed)
    await workspaceState.update(ACTIVE_CONVERSATION_KEY, seed[0]!.id)
    const context = {
      workspaceState,
      globalState: makeMemento(),
      extensionUri: vscode.Uri.file("/ext"),
      storageUri: vscode.Uri.file("/storage"),
      subscriptions: [],
    } as unknown as vscode.ExtensionContext
    const servers = {
      ensure: vi.fn(async () => {
        throw new Error("no backend in startup test")
      }),
      currentBackend: vi.fn(() => undefined),
    } as unknown as ServerManager
    const prefs = { get: () => ({}), onChange: vi.fn(() => ({ dispose: vi.fn() })) } as unknown as Preferences
    const indexManager = {
      onStatusChange: vi.fn(() => ({ dispose: vi.fn() })),
      currentStatus: vi.fn(() => ({ state: "disabled" })),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as IndexManager
    const getConfiguration = vi.mocked(vscode.workspace.getConfiguration)
    const prevImpl = getConfiguration.getMockImplementation()
    getConfiguration.mockImplementation(
      (() => ({ get: (key: string, def?: unknown) => (key === "chat.restoreLastSession" ? true : def) })) as never,
    )
    let chatView: ChatView
    try {
      chatView = new ChatView(context, servers, prefs, {} as RecentEditsTracker, indexManager, undefined)
    } finally {
      getConfiguration.mockImplementation(prevImpl ?? ((() => ({ get: vi.fn() })) as never))
    }
    expect(chatView.activeConversationID()).toBe("conv_seed")
    const fake = makeFakeWebviewView()
    await chatView.resolveWebviewView(fake.view)
    await fake.send({ type: "mounted" })
    const restore = fake.posted.find((m) => m.type === "restore")!
    expect("messages" in restore && restore.messages).toHaveLength(1)
  })
})
