import { describe, it, expect, vi } from "vitest"
import { mkdtempSync, writeFileSync, chmodSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { BinaryUpdateWatch, parseVersion, readBinaryVersion } from "../../src/binary-update"

function fakeBinary(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "opencui-fake-opencode-"))
  const file = join(dir, "opencode")
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, 0o755)
  return file
}

describe("parseVersion", () => {
  it("takes the first semver token, prerelease included", () => {
    expect(parseVersion("1.18.30\n")).toBe("1.18.30")
    expect(parseVersion("opencode v1.19.0-beta.2 (darwin)")).toBe("1.19.0-beta.2")
    expect(parseVersion("")).toBeUndefined()
    expect(parseVersion("not a version")).toBeUndefined()
  })
})

describe("readBinaryVersion", () => {
  it("reads the version a binary prints", async () => {
    expect(await readBinaryVersion(fakeBinary('echo "1.18.30"'))).toBe("1.18.30")
  })

  it("is undefined for a missing or failing binary", async () => {
    expect(await readBinaryVersion(join(tmpdir(), "opencui-no-such-binary"))).toBeUndefined()
    expect(await readBinaryVersion(fakeBinary("exit 3"))).toBeUndefined()
  })
})

function makeWatch(over: {
  running?: string | undefined
  installed?: () => Promise<string | undefined>
  accept?: boolean
  minIntervalMs?: number
} = {}) {
  let now = 1_000_000
  const readVersion = vi.fn(over.installed ?? (async () => "1.18.31"))
  const offerRestart = vi.fn(async () => over.accept ?? true)
  const restart = vi.fn(async () => {})
  const watch = new BinaryUpdateWatch({
    runningVersion: () => ("running" in over ? over.running : "1.18.30"),
    readVersion,
    offerRestart,
    restart,
    now: () => now,
    minIntervalMs: over.minIntervalMs ?? 1000,
  })
  return { watch, readVersion, offerRestart, restart, advance: (ms: number) => (now += ms) }
}

describe("BinaryUpdateWatch (#615)", () => {
  it("does nothing without a running server", async () => {
    const w = makeWatch({ running: undefined })
    await w.watch.check()
    expect(w.readVersion).not.toHaveBeenCalled()
  })

  it("stays quiet when the binary matches the server", async () => {
    const w = makeWatch({ installed: async () => "1.18.30" })
    await w.watch.check()
    expect(w.readVersion).toHaveBeenCalledTimes(1)
    expect(w.offerRestart).not.toHaveBeenCalled()
  })

  it("offers once for a newer binary and restarts when accepted", async () => {
    const w = makeWatch()
    await w.watch.check()
    expect(w.offerRestart).toHaveBeenCalledWith("1.18.31", "1.18.30")
    expect(w.restart).toHaveBeenCalledTimes(1)
  })

  it("does not restart when declined, and does not re-offer the same version", async () => {
    const w = makeWatch({ accept: false })
    await w.watch.check()
    w.advance(5000)
    await w.watch.check()
    expect(w.readVersion).toHaveBeenCalledTimes(2)
    expect(w.offerRestart).toHaveBeenCalledTimes(1)
    expect(w.restart).not.toHaveBeenCalled()
  })

  it("offers again for a newer version after a declined one", async () => {
    let installed = "1.18.31"
    const w = makeWatch({ accept: false, installed: async () => installed })
    await w.watch.check()
    installed = "1.18.32"
    w.advance(5000)
    await w.watch.check()
    expect(w.offerRestart).toHaveBeenLastCalledWith("1.18.32", "1.18.30")
    expect(w.offerRestart).toHaveBeenCalledTimes(2)
  })

  it("reads the binary at most once per interval", async () => {
    const w = makeWatch({ installed: async () => "1.18.30" })
    await w.watch.check()
    w.advance(500)
    await w.watch.check()
    expect(w.readVersion).toHaveBeenCalledTimes(1)
    w.advance(600)
    await w.watch.check()
    expect(w.readVersion).toHaveBeenCalledTimes(2)
  })

  it("coalesces overlapping checks onto one read", async () => {
    let release: (v: string) => void = () => {}
    const w = makeWatch({
      installed: () => new Promise<string>((resolve) => (release = resolve)),
    })
    const first = w.watch.check()
    const second = w.watch.check()
    expect(second).toBe(first)
    release("1.18.30")
    await first
    expect(w.readVersion).toHaveBeenCalledTimes(1)
  })

  it("an unreadable binary is not an offer", async () => {
    const w = makeWatch({ installed: async () => undefined })
    await w.watch.check()
    expect(w.offerRestart).not.toHaveBeenCalled()
  })
})
