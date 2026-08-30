import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as vscode from "vscode"
import { mkdtempSync, writeFileSync, chmodSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ServerManager } from "../../src/server"

// Real fake-binary spawns (same pattern as server-handle.test.ts) so the
// restart contract is pinned through the actual child-process lifecycle,
// not a stubbed startOpencodeServer.
function fakeBinary(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "opencui-fake-opencode-"))
  const file = join(dir, "opencode")
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, 0o755)
  return file
}

// Announces like the real server, then stays alive so onExit doesn't clear
// the cached backend mid-assertion.
function announcing(port: number): string {
  return fakeBinary(`echo "opencode server listening on http://127.0.0.1:${port}"\nexec sleep 10`)
}

const settings: Record<string, unknown> = {}
let manager: ServerManager
let savedFolders: unknown

beforeEach(() => {
  for (const key of Object.keys(settings)) delete settings[key]
  vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
    () => ({ get: (key: string) => settings[key] }) as never,
  )
  // No workspace folder: the mock's "/workspace" doesn't exist on disk and
  // spawn(cwd) would ENOENT before the lifecycle under test even begins.
  savedFolders = vscode.workspace.workspaceFolders
  ;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined
  manager = new ServerManager({ extensionPath: "/nonexistent" } as never)
})

afterEach(async () => {
  await manager.dispose()
  ;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = savedFolders
})

describe("ServerManager.restart", () => {
  it("restart during a hung startup abandons it and boots with freshly-read settings (#581)", async () => {
    // The user's actual scenario: startup hangs (bad binary / never
    // announces), they fix the setting and hit Restart while the 60s
    // window is still open.
    settings.binaryPath = fakeBinary("exec sleep 30")
    const first = manager.ensure()
    first.catch(() => {}) // observed via rejects.toThrow below
    await new Promise((r) => setTimeout(r, 100))

    settings.binaryPath = announcing(43298)
    const backend = await manager.restart()

    // Pre-fix, dispose() no-op'd and ensure() returned the old in-flight
    // attempt — this await would hang on the 30s sleep until timeout.
    expect(backend.url).toBe("http://127.0.0.1:43298")
    await expect(first).rejects.toThrow(/cancelled/)
    expect(manager.currentBackend()?.url).toBe("http://127.0.0.1:43298")
  })

  it("restart after a completed start also re-reads settings", async () => {
    settings.binaryPath = announcing(43297)
    expect((await manager.ensure()).url).toBe("http://127.0.0.1:43297")

    settings.binaryPath = announcing(43296)
    expect((await manager.restart()).url).toBe("http://127.0.0.1:43296")
  })

  it("dispose during startup settles the attempt (deactivation must not leak the spawning child)", async () => {
    settings.binaryPath = fakeBinary("exec sleep 30")
    const first = manager.ensure()
    first.catch(() => {})
    await new Promise((r) => setTimeout(r, 100))

    await manager.dispose()

    await expect(first).rejects.toThrow(/cancelled/)
    expect(manager.currentBackend()).toBeUndefined()
  })
})
