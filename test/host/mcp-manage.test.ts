import { describe, it, expect, beforeEach, vi } from "vitest"
import * as vscode from "vscode"
import { McpManager } from "../../src/mcp/manage"
import type { ServerManager } from "../../src/server"

// Drives McpManager end-to-end against a stubbed SDK client + scripted
// vscode.window prompts (no real VS Code, no real opencode). showQuickPick /
// showInputBox return values are queued per call in invocation order; the final
// main-picker call returns undefined to break the run() loop (Esc).

const win = vscode.window as unknown as {
  showQuickPick: ReturnType<typeof vi.fn>
  showInputBox: ReturnType<typeof vi.fn>
  showInformationMessage: ReturnType<typeof vi.fn>
  showErrorMessage: ReturnType<typeof vi.fn>
  showWarningMessage: ReturnType<typeof vi.fn>
}
const writeText = (vscode.env.clipboard.writeText as unknown) as ReturnType<typeof vi.fn>

type McpStub = {
  status: ReturnType<typeof vi.fn>
  add: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  auth: { authenticate: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
}

function makeMcp(overrides: Partial<McpStub> = {}): McpStub {
  return {
    status: vi.fn().mockResolvedValue({ data: {} }),
    add: vi.fn().mockResolvedValue({ data: {} }),
    connect: vi.fn().mockResolvedValue({ data: true }),
    disconnect: vi.fn().mockResolvedValue({ data: true }),
    auth: {
      authenticate: vi.fn().mockResolvedValue({ data: { status: "connected" } }),
      remove: vi.fn().mockResolvedValue({ data: { success: true } }),
    },
    ...overrides,
  }
}

function makeManager(mcp: McpStub) {
  const backend = { url: "http://127.0.0.1:1", directory: "/ws", client: { mcp }, configMode: "isolated" }
  const servers = { ensure: vi.fn().mockResolvedValue(backend) } as unknown as ServerManager
  return new McpManager(servers)
}

const Q = { directory: "/ws" }

beforeEach(() => {
  // Clear history + queued once-values for the prompt fns (leave withProgress's
  // setup impl, which runs the task, intact).
  win.showQuickPick.mockReset()
  win.showInputBox.mockReset()
  win.showInformationMessage.mockReset()
  win.showErrorMessage.mockReset()
  win.showWarningMessage.mockReset()
  writeText.mockReset()
})

describe("McpManager.run", () => {
  it("exits immediately when the main picker is dismissed", async () => {
    const mcp = makeMcp({ status: vi.fn().mockResolvedValue({ data: { github: { status: "connected" } } }) })
    win.showQuickPick.mockResolvedValueOnce(undefined)
    await makeManager(mcp).run()
    expect(mcp.status).toHaveBeenCalledTimes(1)
    expect(mcp.disconnect).not.toHaveBeenCalled()
  })

  it("disconnects a connected server, then re-fetches status", async () => {
    const mcp = makeMcp({ status: vi.fn().mockResolvedValue({ data: { github: { status: "connected" } } }) })
    win.showQuickPick
      .mockResolvedValueOnce({ server: "github" })
      .mockResolvedValueOnce({ action: "disconnect" })
      .mockResolvedValueOnce(undefined)
    await makeManager(mcp).run()
    expect(mcp.disconnect).toHaveBeenCalledWith({ path: { name: "github" }, query: Q })
    expect(mcp.status).toHaveBeenCalledTimes(2) // initial open + after the action
  })

  it("authenticates a needs_auth server via the server-orchestrated flow", async () => {
    const mcp = makeMcp({ status: vi.fn().mockResolvedValue({ data: { linear: { status: "needs_auth" } } }) })
    win.showQuickPick
      .mockResolvedValueOnce({ server: "linear" })
      .mockResolvedValueOnce({ action: "authenticate" })
      .mockResolvedValueOnce(undefined)
    await makeManager(mcp).run()
    expect(mcp.auth.authenticate).toHaveBeenCalledWith({ path: { name: "linear" }, query: Q })
    expect(win.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("connected"))
  })

  it("removes OAuth credentials on sign out", async () => {
    const mcp = makeMcp({ status: vi.fn().mockResolvedValue({ data: { linear: { status: "needs_auth" } } }) })
    win.showQuickPick
      .mockResolvedValueOnce({ server: "linear" })
      .mockResolvedValueOnce({ action: "signout" })
      .mockResolvedValueOnce(undefined)
    await makeManager(mcp).run()
    expect(mcp.auth.remove).toHaveBeenCalledWith({ path: { name: "linear" }, query: Q })
  })

  it("adds a local server, splitting the command into argv", async () => {
    const mcp = makeMcp({ add: vi.fn().mockResolvedValue({ data: { gh: { status: "connected" } } }) })
    win.showInputBox
      .mockResolvedValueOnce("gh") // name
      .mockResolvedValueOnce("npx -y server-github") // command
    win.showQuickPick
      .mockResolvedValueOnce({ add: true }) // main -> Add
      .mockResolvedValueOnce({ value: "local" }) // type
      .mockResolvedValueOnce(undefined) // main reopens -> Esc
    await makeManager(mcp).run()
    expect(mcp.add).toHaveBeenCalledWith({
      body: { name: "gh", config: { type: "local", command: ["npx", "-y", "server-github"], enabled: true } },
      query: Q,
    })
    expect(win.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("permanent"))
  })

  it("adds a remote server with the entered url", async () => {
    const mcp = makeMcp()
    win.showInputBox
      .mockResolvedValueOnce("remote1") // name
      .mockResolvedValueOnce("https://example.com/mcp") // url
    win.showQuickPick
      .mockResolvedValueOnce({ add: true })
      .mockResolvedValueOnce({ value: "remote" })
      .mockResolvedValueOnce(undefined)
    await makeManager(mcp).run()
    expect(mcp.add).toHaveBeenCalledWith({
      body: { name: "remote1", config: { type: "remote", url: "https://example.com/mcp", enabled: true } },
      query: Q,
    })
  })

  it("aborts the Add flow when the name prompt is cancelled", async () => {
    const mcp = makeMcp()
    win.showInputBox.mockResolvedValueOnce(undefined) // cancel at name
    win.showQuickPick
      .mockResolvedValueOnce({ add: true })
      .mockResolvedValueOnce(undefined)
    await makeManager(mcp).run()
    expect(mcp.add).not.toHaveBeenCalled()
  })

  it("shows and copies a failed server's error", async () => {
    const mcp = makeMcp({
      status: vi.fn().mockResolvedValue({ data: { postgres: { status: "failed", error: "ECONNREFUSED" } } }),
    })
    win.showQuickPick
      .mockResolvedValueOnce({ server: "postgres" })
      .mockResolvedValueOnce({ action: "showError" })
      .mockResolvedValueOnce(undefined)
    win.showErrorMessage.mockResolvedValueOnce("Copy")
    await makeManager(mcp).run()
    expect(writeText).toHaveBeenCalledWith("ECONNREFUSED")
  })

  it("surfaces a status-fetch failure and stops before showing a picker", async () => {
    const mcp = makeMcp({ status: vi.fn().mockResolvedValue({ error: { message: "boom" } }) })
    await makeManager(mcp).run()
    expect(win.showErrorMessage).toHaveBeenCalled()
    expect(win.showQuickPick).not.toHaveBeenCalled()
  })
})
