import { describe, it, expect } from "vitest"
import { mkdtempSync, writeFileSync, chmodSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { startOpencodeServer } from "../../src/server"

// A stand-in opencode binary: announces readiness like the real server, then
// exits shortly after — letting us observe the post-startup exit notification
// without a real opencode install.
function fakeBinary(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "opencui-fake-opencode-"))
  const file = join(dir, "opencode")
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, 0o755)
  return file
}

describe("startOpencodeServer exit notification", () => {
  it("notifies onExit listeners when the process dies AFTER startup", async () => {
    const bin = fakeBinary('echo "opencode server listening on http://127.0.0.1:43210"\nsleep 0.2')
    const handle = await startOpencodeServer(bin, {
      hostname: "127.0.0.1",
      port: 43210,
      timeout: 5000,
      configMode: "isolated",
    })
    expect(handle.url).toBe("http://127.0.0.1:43210")
    let exits = 0
    handle.onExit(() => exits++)
    await new Promise((r) => setTimeout(r, 600))
    // Regression: the old exit handler returned early once `settled`, so a
    // post-startup crash was invisible and ensure() served the dead backend.
    expect(exits).toBe(1)
  })

  it("rejects (and does not notify) when the process dies BEFORE startup", async () => {
    const bin = fakeBinary("exit 7")
    await expect(
      startOpencodeServer(bin, {
        hostname: "127.0.0.1",
        port: 43211,
        timeout: 5000,
        configMode: "isolated",
      }),
    ).rejects.toThrow(/exited with code 7/)
  })

  it("aborting the signal mid-startup rejects AND kills the spawned process (#581)", async () => {
    // `exec` so the sh pid IS the sleep pid — the kill check below targets
    // the process the handle actually manages.
    const bin = fakeBinary("exec sleep 30")
    const abort = new AbortController()
    let pid: number | undefined
    const attempt = startOpencodeServer(bin, {
      hostname: "127.0.0.1",
      port: 43212,
      timeout: 5000,
      configMode: "isolated",
      onSpawn: (p) => (pid = p),
      signal: abort.signal,
    })
    abort.abort()
    await expect(attempt).rejects.toThrow(/cancelled/)
    expect(pid).toBeDefined()
    const gone = async () => {
      for (let i = 0; i < 30; i++) {
        try {
          process.kill(pid!, 0)
        } catch {
          return true
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      return false
    }
    expect(await gone()).toBe(true)
  })

  it("an already-aborted signal rejects without spawning at all", async () => {
    const abort = new AbortController()
    abort.abort()
    let spawned = false
    await expect(
      startOpencodeServer("/nonexistent/opencode", {
        hostname: "127.0.0.1",
        port: 43213,
        timeout: 5000,
        configMode: "isolated",
        onSpawn: () => (spawned = true),
        signal: abort.signal,
      }),
    ).rejects.toThrow(/cancelled/)
    expect(spawned).toBe(false)
  })
})
