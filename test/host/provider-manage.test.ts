import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as vscode from "vscode"
import { ProviderManager } from "../../src/provider/manage"
import type { ServerManager } from "../../src/server"
import type { Preferences } from "../../src/preferences"

// Drives ProviderManager end-to-end against a stubbed SDK client + scripted
// vscode.window prompts + a stubbed global fetch (the removal call is an
// untyped DELETE, since no published SDK exposes provider-credential removal).
// showQuickPick / showWarningMessage return values are queued per call in
// invocation order; the final main-picker call returns undefined to break the
// run() loop (Esc).

const win = vscode.window as unknown as {
  showQuickPick: ReturnType<typeof vi.fn>
  showInformationMessage: ReturnType<typeof vi.fn>
  showErrorMessage: ReturnType<typeof vi.fn>
  showWarningMessage: ReturnType<typeof vi.fn>
}
const exec = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>
const writeText = vscode.env.clipboard.writeText as unknown as ReturnType<typeof vi.fn>

function makeBackend(connected: string[], providers: Array<{ id: string; name: string; source: string }>) {
  return {
    url: "http://127.0.0.1:1234",
    directory: "/ws",
    configMode: "isolated",
    client: {
      provider: { list: vi.fn().mockResolvedValue({ data: { connected, all: [], default: {} } }) },
      config: { providers: vi.fn().mockResolvedValue({ data: { providers, default: {} } }) },
    },
  }
}

function makeManager(backend: unknown, selection: { modelProviderID?: string } = {}) {
  const servers = { ensure: vi.fn().mockResolvedValue(backend) } as unknown as ServerManager
  const prefs = { get: vi.fn().mockReturnValue(selection) } as unknown as Preferences
  return new ProviderManager(servers, prefs)
}

const row = (id: string, name: string, source: string, removable: boolean) => ({ id, name, source, removable })
const Q = { query: { directory: "/ws" } }
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  win.showQuickPick.mockReset()
  win.showInformationMessage.mockReset()
  win.showErrorMessage.mockReset()
  win.showWarningMessage.mockReset()
  exec.mockReset()
  writeText.mockReset()
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ProviderManager.run", () => {
  it("lists connected providers and exits when the picker is dismissed", async () => {
    const backend = makeBackend(["anthropic"], [{ id: "anthropic", name: "Anthropic", source: "config" }])
    win.showQuickPick.mockResolvedValueOnce(undefined)
    await makeManager(backend).run()
    expect(backend.client.provider.list).toHaveBeenCalledWith(Q)
    const items = win.showQuickPick.mock.calls[0]![0] as Array<{ label: string }>
    expect(items.map((i) => i.label)).toContain("$(key) Anthropic")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("disconnects a removable provider after confirm, then re-fetches", async () => {
    const backend = makeBackend(["anthropic"], [{ id: "anthropic", name: "Anthropic", source: "config" }])
    win.showQuickPick
      .mockResolvedValueOnce({ row: row("anthropic", "Anthropic", "config", true) })
      .mockResolvedValueOnce(undefined)
    win.showWarningMessage.mockResolvedValueOnce("Remove") // confirm modal
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    await makeManager(backend).run()
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:1234/auth/anthropic", { method: "DELETE" })
    expect(win.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("removed credentials"))
    expect(backend.client.provider.list).toHaveBeenCalledTimes(2) // open + after the action
  })

  it("does nothing when the confirm modal is dismissed", async () => {
    const backend = makeBackend(["anthropic"], [{ id: "anthropic", name: "Anthropic", source: "config" }])
    win.showQuickPick
      .mockResolvedValueOnce({ row: row("anthropic", "Anthropic", "config", true) })
      .mockResolvedValueOnce(undefined)
    win.showWarningMessage.mockResolvedValueOnce(undefined) // dismissed
    await makeManager(backend).run()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows the guarded hint + copies the CLI command on a 404 (unsupported)", async () => {
    const backend = makeBackend(["anthropic"], [{ id: "anthropic", name: "Anthropic", source: "config" }])
    win.showQuickPick
      .mockResolvedValueOnce({ row: row("anthropic", "Anthropic", "config", true) })
      .mockResolvedValueOnce(undefined)
    win.showWarningMessage
      .mockResolvedValueOnce("Remove") // confirm
      .mockResolvedValueOnce("Copy command") // unsupported hint action
    fetchMock.mockResolvedValue({ ok: false, status: 404 })
    await makeManager(backend).run()
    expect(writeText).toHaveBeenCalledWith("opencode auth logout")
  })

  it("refuses env-sourced providers without confirming or calling fetch", async () => {
    const backend = makeBackend(["openai"], [{ id: "openai", name: "OpenAI", source: "env" }])
    win.showQuickPick
      .mockResolvedValueOnce({ row: row("openai", "OpenAI", "env", false) })
      .mockResolvedValueOnce(undefined)
    await makeManager(backend).run()
    expect(win.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("environment variable"))
    expect(win.showWarningMessage).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("warns + offers the model picker when the active model's provider is removed", async () => {
    const backend = makeBackend(["anthropic"], [{ id: "anthropic", name: "Anthropic", source: "config" }])
    win.showQuickPick
      .mockResolvedValueOnce({ row: row("anthropic", "Anthropic", "config", true) })
      .mockResolvedValueOnce(undefined)
    win.showWarningMessage
      .mockResolvedValueOnce("Remove") // confirm
      .mockResolvedValueOnce("Select model") // active-model warning action
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    await makeManager(backend, { modelProviderID: "anthropic" }).run()
    expect(exec).toHaveBeenCalledWith("opencui.selectModel")
  })

  it("surfaces a provider-fetch failure and stops before showing a picker", async () => {
    const backend = makeBackend([], [])
    backend.client.provider.list = vi.fn().mockResolvedValue({ error: { message: "boom" } })
    await makeManager(backend).run()
    expect(win.showErrorMessage).toHaveBeenCalled()
    expect(win.showQuickPick).not.toHaveBeenCalled()
  })
})
