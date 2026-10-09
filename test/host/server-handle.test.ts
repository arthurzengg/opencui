import { describe, it, expect } from "vitest"
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { startOpencodeServer, UnsupportedOpencodeError } from "../../src/server"

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

async function waitForExit(pid: number | undefined) {
  expect(pid).toBeDefined()
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid!, 0)
    } catch {
      return
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`process ${pid} is still alive`)
}

describe("opencode 2.0 binaries (#691)", () => {
  // 2.0 prints "server listening on" without the "opencode " prefix, then its
  // password. The old code waited out the whole timeout and quoted the output.
  it("fails within a second, names the setting, kills the server, and never repeats the password", async () => {
    const bin = fakeBinary('echo "server listening on http://127.0.0.1:43216"\necho "server password hunter2"\nexec sleep 10')
    let pid: number | undefined
    const started = Date.now()
    const error: Error = await startOpencodeServer(bin, {
      hostname: "127.0.0.1",
      port: 43216,
      timeout: 5000,
      configMode: "isolated",
      onSpawn: (p) => (pid = p),
    }).then(
      () => {
        throw new Error("should have rejected")
      },
      (e: Error) => e,
    )
    expect(error).toBeInstanceOf(UnsupportedOpencodeError)
    expect(error.message).toMatch(/opencode 2\.0/)
    expect(error.message).toContain("opencui.binaryPath")
    expect(error.message).toContain(bin)
    expect(error.message).not.toContain("hunter2")
    expect(Date.now() - started).toBeLessThan(1500)
    await waitForExit(pid)
  })

  it("redacts the 2.0 password from the output a startup timeout quotes", async () => {
    const bin = fakeBinary('echo "server password hunter2"\nexec sleep 10')
    const error: Error = await startOpencodeServer(bin, {
      hostname: "127.0.0.1",
      port: 43217,
      timeout: 300,
      configMode: "isolated",
    }).catch((e: Error) => e)
    expect(error.message).toMatch(/Timeout waiting/)
    expect(error.message).toContain("server password [redacted]")
    expect(error.message).not.toContain("hunter2")
  })
})

describe("opencode 2.0 starts (#693)", () => {
  it("passes the password to the binary and accepts the 2.0 startup line when asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencui-v2-start-"))
    const seen = join(dir, "password.txt")
    const bin = fakeBinary(`echo "$OPENCODE_PASSWORD" > "${seen}"\necho "server listening on http://127.0.0.1:43218"\necho "server password $OPENCODE_PASSWORD"\nexec sleep 10`)
    const handle = await startOpencodeServer(bin, {
      hostname: "127.0.0.1",
      port: 43218,
      timeout: 5000,
      configMode: "isolated",
      opencode2: { password: "pw-under-test" },
    })
    try {
      expect(handle.url).toBe("http://127.0.0.1:43218")
      expect(readFileSync(seen, "utf8").trim()).toBe("pw-under-test")
    } finally {
      handle.close()
    }
  })
})
