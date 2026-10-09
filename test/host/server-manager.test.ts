import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as vscode from "vscode"
import { mkdtempSync, writeFileSync, chmodSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ServerManager, UnsupportedOpencodeError } from "../../src/server"

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


async function until(cond: () => boolean, ms = 4000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time")
    await new Promise((r) => setTimeout(r, 10))
  }
}

// A fake that also answers the health route, so the version the manager
// records comes through the real client and not a stub.
function healthServing(port: number, version: string): string {
  const js = [
    'const http=require("http")',
    `const port=${port}`,
    "http.createServer((req,res)=>{",
    'if(req.url.startsWith("/global/health")){res.setHeader("content-type","application/json");',
    `res.end(JSON.stringify({healthy:true,version:"${version}"}));return}`,
    "res.statusCode=404;res.end()",
    '}).listen(port,"127.0.0.1",()=>console.log("opencode server listening on http://127.0.0.1:"+port))',
    "setTimeout(()=>process.exit(0),10000)",
  ].join(";")
  return fakeBinary(`exec node -e '${js}'`)
}

// A 2.0 stand-in: the new startup lines, Basic auth with the password it
// was started with, and the version on 2.0's info route.
function opencode2Serving(port: number, version: string): string {
  const js = [
    'const http=require("http")',
    `const port=${port}`,
    'const expected="Basic "+Buffer.from("opencode:"+process.env.OPENCODE_PASSWORD).toString("base64")',
    "http.createServer((req,res)=>{",
    'if(req.headers.authorization!==expected){res.statusCode=401;res.end();return}',
    'if(req.url.startsWith("/api/info")){res.setHeader("content-type","application/json");',
    `res.end(JSON.stringify({version:"${version}",pid:process.pid,urls:[],paths:{tmp:"/tmp"}}));return}`,
    "res.statusCode=404;res.end()",
    '}).listen(port,"127.0.0.1",()=>{console.log("server listening on http://127.0.0.1:"+port);console.log("server password "+process.env.OPENCODE_PASSWORD)})',
    "setTimeout(()=>process.exit(0),10000)",
  ].join(";")
  return fakeBinary(`exec node -e '${js}'`)
}

describe("ServerManager with opencode 2.0 (#693)", () => {
  it("starts a 2.0 binary with a password and reads its version through Basic auth when the setting is on", async () => {
    settings.binaryPath = opencode2Serving(43301, "2.0.24")
    settings.opencode2 = true
    const v2 = new ServerManager({ extensionPath: "/nonexistent" } as never, { readVersion: async () => "2.0.24" })
    try {
      const backend = await v2.ensure()
      expect(backend.url).toBe("http://127.0.0.1:43301")
      await until(() => v2.currentVersion() === "2.0.24")
    } finally {
      await v2.dispose()
    }
  })

  it("keeps the fail-fast when the setting is off", async () => {
    settings.binaryPath = opencode2Serving(43302, "2.0.24")
    const v2 = new ServerManager({ extensionPath: "/nonexistent" } as never, { readVersion: async () => "2.0.24" })
    try {
      await expect(v2.ensure()).rejects.toBeInstanceOf(UnsupportedOpencodeError)
    } finally {
      await v2.dispose()
    }
  })

  it("starts a 1.x binary the 1.x way even with the setting on", async () => {
    settings.binaryPath = healthServing(43303, "1.18.35")
    settings.opencode2 = true
    const v1 = new ServerManager({ extensionPath: "/nonexistent" } as never, { readVersion: async () => "1.18.35" })
    try {
      await v1.ensure()
      await until(() => v1.currentVersion() === "1.18.35")
    } finally {
      await v1.dispose()
    }
  })
})

describe("ServerManager version and binary path (#615)", () => {
  it("records the spawned binary path and the version the health route reports", async () => {
    settings.binaryPath = healthServing(43295, "9.9.9")
    expect(manager.currentVersion()).toBeUndefined()
    expect(manager.currentBinaryPath()).toBeUndefined()

    await manager.ensure()
    expect(manager.currentBinaryPath()).toBe(settings.binaryPath)
    await until(() => manager.currentVersion() === "9.9.9")

    await manager.dispose()
    expect(manager.currentVersion()).toBeUndefined()
    expect(manager.currentBinaryPath()).toBeUndefined()
  })
})
