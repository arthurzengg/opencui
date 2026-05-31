import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as vscode from "vscode"
import { ProviderManager } from "../../src/provider/manage"
import type { ServerManager } from "../../src/server"
import type { Preferences } from "../../src/preferences"

// Drives ProviderManager end-to-end against a stubbed SDK client + scripted
// vscode.window prompts + a stubbed global fetch (disconnect is an untyped
// DELETE). showQuickPick / showWarningMessage / showInputBox return values are
// queued per call in invocation order; the final main-picker call returns
// undefined to break the run() loop (Esc). The mocks return scripted objects,
// so the connect row is represented as `{ connect: true }`.

const win = vscode.window as unknown as {
  showQuickPick: ReturnType<typeof vi.fn>
  showInputBox: ReturnType<typeof vi.fn>
  showInformationMessage: ReturnType<typeof vi.fn>
  showErrorMessage: ReturnType<typeof vi.fn>
  showWarningMessage: ReturnType<typeof vi.fn>
}
const exec = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>
const writeText = vscode.env.clipboard.writeText as unknown as ReturnType<typeof vi.fn>
const openExternal = vscode.env.openExternal as unknown as ReturnType<typeof vi.fn>

type BackendOpts = {
  connected?: string[]
  providers?: Array<{ id: string; name: string; source: string }>
  all?: Array<{ id: string; name: string }>
  auth?: Record<string, Array<{ type: string; label: string }>>
}

function makeBackend(opts: BackendOpts = {}) {
  return {
    url: "http://127.0.0.1:1234",
    directory: "/ws",
    configMode: "isolated",
    client: {
      provider: {
        list: vi.fn().mockResolvedValue({ data: { connected: opts.connected ?? [], all: opts.all ?? [], default: {} } }),
        auth: vi.fn().mockResolvedValue({ data: opts.auth ?? {} }),
        oauth: {
          authorize: vi.fn().mockResolvedValue({ data: { url: "https://auth.example/x", method: "auto", instructions: "" } }),
          callback: vi.fn().mockResolvedValue({ data: true }),
        },
      },
      config: { providers: vi.fn().mockResolvedValue({ data: { providers: opts.providers ?? [], default: {} } }) },
      auth: { set: vi.fn().mockResolvedValue({ data: true }) },
    },
  }
}

function makeManager(backend: unknown, selection: { modelProviderID?: string } = {}) {
  const servers = { ensure: vi.fn().mockResolvedValue(backend) } as unknown as ServerManager
  const prefs = { get: vi.fn().mockReturnValue(selection) } as unknown as Preferences
  return new ProviderManager(servers, prefs)
}

const row = (id: string, name: string, source: string, removable: boolean) => ({ id, name, source, removable })
const choice = (id: string, name: string, methods: Array<{ type: string; label: string }>) => ({
  id,
  name,
  connected: false,
  methods,
})
const Q = { query: { directory: "/ws" } }
const QD = { directory: "/ws" }
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  win.showQuickPick.mockReset()
  win.showInputBox.mockReset()
  win.showInformationMessage.mockReset()
  win.showErrorMessage.mockReset()
  win.showWarningMessage.mockReset()
  exec.mockReset()
  writeText.mockReset()
  openExternal.mockReset()
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ProviderManager.run — listing & disconnect", () => {
  it("lists connected providers (after the Connect row) and exits when dismissed", async () => {
    const backend = makeBackend({ connected: ["anthropic"], providers: [{ id: "anthropic", name: "Anthropic", source: "config" }] })
    win.showQuickPick.mockResolvedValueOnce(undefined)
    await makeManager(backend).run()
    expect(backend.client.provider.list).toHaveBeenCalledWith(Q)
    const items = win.showQuickPick.mock.calls[0]![0] as Array<{ label: string }>
    expect(items[0]!.label).toContain("Connect a provider")
    expect(items.map((i) => i.label)).toContain("$(key) Anthropic")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("disconnects a removable provider after confirm, then re-fetches", async () => {
    const backend = makeBackend({ connected: ["anthropic"], providers: [{ id: "anthropic", name: "Anthropic", source: "config" }] })
    win.showQuickPick.mockResolvedValueOnce({ row: row("anthropic", "Anthropic", "config", true) }).mockResolvedValueOnce(undefined)
    win.showWarningMessage.mockResolvedValueOnce("Remove")
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    await makeManager(backend).run()
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:1234/auth/anthropic", { method: "DELETE" })
    expect(win.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("removed credentials"))
    expect(backend.client.provider.list).toHaveBeenCalledTimes(2)
  })

  it("does nothing when the confirm modal is dismissed", async () => {
    const backend = makeBackend({ connected: ["anthropic"], providers: [{ id: "anthropic", name: "Anthropic", source: "config" }] })
    win.showQuickPick.mockResolvedValueOnce({ row: row("anthropic", "Anthropic", "config", true) }).mockResolvedValueOnce(undefined)
    win.showWarningMessage.mockResolvedValueOnce(undefined)
    await makeManager(backend).run()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows the guarded hint + copies the CLI command on a 404 (unsupported)", async () => {
    const backend = makeBackend({ connected: ["anthropic"], providers: [{ id: "anthropic", name: "Anthropic", source: "config" }] })
    win.showQuickPick.mockResolvedValueOnce({ row: row("anthropic", "Anthropic", "config", true) }).mockResolvedValueOnce(undefined)
    win.showWarningMessage.mockResolvedValueOnce("Remove").mockResolvedValueOnce("Copy command")
    fetchMock.mockResolvedValue({ ok: false, status: 404 })
    await makeManager(backend).run()
    expect(writeText).toHaveBeenCalledWith("opencode auth logout")
  })

  it("refuses env-sourced providers without confirming or calling fetch", async () => {
    const backend = makeBackend({ connected: ["openai"], providers: [{ id: "openai", name: "OpenAI", source: "env" }] })
    win.showQuickPick.mockResolvedValueOnce({ row: row("openai", "OpenAI", "env", false) }).mockResolvedValueOnce(undefined)
    await makeManager(backend).run()
    expect(win.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("environment variable"))
    expect(win.showWarningMessage).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("warns + offers the model picker when the active model's provider is removed", async () => {
    const backend = makeBackend({ connected: ["anthropic"], providers: [{ id: "anthropic", name: "Anthropic", source: "config" }] })
    win.showQuickPick.mockResolvedValueOnce({ row: row("anthropic", "Anthropic", "config", true) }).mockResolvedValueOnce(undefined)
    win.showWarningMessage.mockResolvedValueOnce("Remove").mockResolvedValueOnce("Select model")
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    await makeManager(backend, { modelProviderID: "anthropic" }).run()
    expect(exec).toHaveBeenCalledWith("opencui.selectModel")
  })

  it("surfaces a provider-fetch failure and stops before showing a picker", async () => {
    const backend = makeBackend()
    backend.client.provider.list = vi.fn().mockResolvedValue({ error: { message: "boom" } })
    await makeManager(backend).run()
    expect(win.showErrorMessage).toHaveBeenCalled()
    expect(win.showQuickPick).not.toHaveBeenCalled()
  })
})

describe("ProviderManager.run — connect", () => {
  it("connects a provider via API key (auth.set)", async () => {
    const backend = makeBackend({ all: [{ id: "openai", name: "OpenAI" }], auth: { openai: [{ type: "api", label: "API Key" }] } })
    win.showQuickPick
      .mockResolvedValueOnce({ connect: true }) // main -> Connect
      .mockResolvedValueOnce({ choice: choice("openai", "OpenAI", [{ type: "api", label: "API Key" }]) })
      .mockResolvedValueOnce(undefined) // main reopens -> Esc
    win.showInputBox.mockResolvedValueOnce("sk-test-123")
    await makeManager(backend).run()
    expect(backend.client.auth.set).toHaveBeenCalledWith({
      path: { id: "openai" },
      query: QD,
      body: { type: "api", key: "sk-test-123" },
    })
    expect(win.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("connected"))
  })

  it("connects via OAuth (auto): opens the browser then callbacks without a code", async () => {
    const backend = makeBackend({ all: [{ id: "anthropic", name: "Anthropic" }], auth: { anthropic: [{ type: "oauth", label: "Claude Pro/Max" }] } })
    win.showQuickPick
      .mockResolvedValueOnce({ connect: true })
      .mockResolvedValueOnce({ choice: choice("anthropic", "Anthropic", [{ type: "oauth", label: "Claude Pro/Max" }]) })
      .mockResolvedValueOnce(undefined)
    await makeManager(backend).run()
    expect(openExternal).toHaveBeenCalled()
    expect(backend.client.provider.oauth.authorize).toHaveBeenCalledWith({ path: { id: "anthropic" }, query: QD, body: { method: 0 } })
    expect(backend.client.provider.oauth.callback).toHaveBeenCalledWith({ path: { id: "anthropic" }, query: QD, body: { method: 0 } })
    expect(win.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("connected"))
  })

  it("connects via OAuth (code): prompts for the authorization code", async () => {
    const backend = makeBackend({ all: [{ id: "openai", name: "OpenAI" }], auth: { openai: [{ type: "oauth", label: "ChatGPT" }] } })
    backend.client.provider.oauth.authorize = vi
      .fn()
      .mockResolvedValue({ data: { url: "https://auth/x", method: "code", instructions: "Paste the code" } })
    win.showQuickPick
      .mockResolvedValueOnce({ connect: true })
      .mockResolvedValueOnce({ choice: choice("openai", "OpenAI", [{ type: "oauth", label: "ChatGPT" }]) })
      .mockResolvedValueOnce(undefined)
    win.showInputBox.mockResolvedValueOnce("the-code")
    await makeManager(backend).run()
    expect(backend.client.provider.oauth.callback).toHaveBeenCalledWith({ path: { id: "openai" }, query: QD, body: { method: 0, code: "the-code" } })
  })

  it("asks which login method when a provider exposes more than one", async () => {
    const methods = [
      { type: "oauth", label: "Claude Pro/Max" },
      { type: "api", label: "API Key" },
    ]
    const backend = makeBackend({ all: [{ id: "anthropic", name: "Anthropic" }], auth: { anthropic: methods } })
    win.showQuickPick
      .mockResolvedValueOnce({ connect: true })
      .mockResolvedValueOnce({ choice: choice("anthropic", "Anthropic", methods) })
      .mockResolvedValueOnce({ index: 1 }) // method picker -> API Key
      .mockResolvedValueOnce(undefined)
    win.showInputBox.mockResolvedValueOnce("sk-xyz")
    await makeManager(backend).run()
    expect(backend.client.auth.set).toHaveBeenCalledWith({ path: { id: "anthropic" }, query: QD, body: { type: "api", key: "sk-xyz" } })
  })

  it("reports when no providers are available to connect", async () => {
    const backend = makeBackend({ auth: {} })
    win.showQuickPick.mockResolvedValueOnce({ connect: true }).mockResolvedValueOnce(undefined)
    await makeManager(backend).run()
    expect(win.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("no providers available"))
  })
})
