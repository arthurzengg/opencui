import * as assert from "node:assert"
import * as vscode from "vscode"

const EXTENSION_ID = "haoyangzeng.opencui"

suite("Extension activation", () => {
  test("extension is registered", () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)
    assert.ok(ext, `extension ${EXTENSION_ID} not found`)
  })

  test("extension activates on startup", async function () {
    this.timeout(30_000)
    const ext = vscode.extensions.getExtension(EXTENSION_ID)!
    if (!ext.isActive) {
      await ext.activate()
    }
    assert.strictEqual(ext.isActive, true)
  })
})

suite("Command registration", () => {
  const commands = [
    "opencui.chat.focus",
    "opencui.chat.new",
    "opencui.conversation.select",
    "opencui.inlineEdit",
    "opencui.selectAgent",
    "opencui.selectModel",
    "opencui.server.restart",
    "opencui.showLogs",
  ]

  for (const id of commands) {
    test(`command ${id} is registered`, async () => {
      const all = await vscode.commands.getCommands(true)
      assert.ok(all.includes(id), `${id} not in registered command list`)
    })
  }
})

suite("Settings", () => {
  test("opencui.binaryPath default is 'opencode'", () => {
    const config = vscode.workspace.getConfiguration("opencui")
    const binaryPath = config.get<string>("binaryPath")
    assert.strictEqual(binaryPath, "opencode")
  })

  test("opencui.serverPort default is 0", () => {
    const config = vscode.workspace.getConfiguration("opencui")
    const port = config.get<number>("serverPort")
    assert.strictEqual(port, 0)
  })
})

suite("Webview round-trip", () => {
  async function until(cond: () => boolean, ms: number, label: string) {
    const start = Date.now()
    while (!cond()) {
      if (Date.now() - start > ms) {
        assert.fail(`timed out after ${ms}ms waiting for ${label}`)
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  test("the chat webview loads its bundle and completes the mounted handshake", async function () {
    this.timeout(45_000)
    const ext = vscode.extensions.getExtension(EXTENSION_ID)!
    if (!ext.isActive) await ext.activate()
    const api = ext.exports as {
      chatWebviewState: () => { resolved: boolean; mounted: boolean }
    }
    assert.ok(api?.chatWebviewState, "activate() should export chatWebviewState")

    // Opening the container makes VS Code resolve the webview view provider,
    // which loads the real bundled React app inside a real webview.
    await vscode.commands.executeCommand("workbench.view.extension.opencui")
    await until(() => api.chatWebviewState().resolved, 15_000, "resolveWebviewView")

    // The bundle booting and posting `mounted` proves the CSP, the single-file
    // bundle, and the host<->webview protocol all work end to end — the one
    // thing unit tests cannot observe.
    await until(() => api.chatWebviewState().mounted, 30_000, "the webview mounted handshake")
  })
})
