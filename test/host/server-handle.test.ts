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
})
