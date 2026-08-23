import { describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  readRegistry,
  recordServer,
  releaseServer,
  reapOrphanServers,
  registryPath,
  type ProcessOps,
  type ServerRecord,
} from "../../src/server-registry"

function tmpRegistry(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencui-registry-"))
  return registryPath(dir)
}

const OWN_PID = 1000

function record(pid: number, ownerPid: number): ServerRecord {
  return { pid, ownerPid, startedAt: 123 }
}

function ops(overrides: Partial<ProcessOps> = {}): ProcessOps {
  return {
    isAlive: () => true,
    commandOf: async () => "/usr/local/bin/opencode serve --hostname=127.0.0.1 --port=1234",
    terminate: vi.fn(),
    ...overrides,
  }
}

describe("server registry file", () => {
  it("records, replaces by pid, and releases", () => {
    const file = tmpRegistry()
    recordServer(file, record(1, 10))
    recordServer(file, record(2, 10))
    recordServer(file, { pid: 1, ownerPid: 99, startedAt: 456 })
    expect(readRegistry(file)).toEqual([record(2, 10), { pid: 1, ownerPid: 99, startedAt: 456 }])
    releaseServer(file, 1)
    expect(readRegistry(file)).toEqual([record(2, 10)])
  })

  it("tolerates a missing or corrupt file and malformed entries", () => {
    const file = tmpRegistry()
    expect(readRegistry(file)).toEqual([])
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "not json")
    expect(readRegistry(file)).toEqual([])
    fs.writeFileSync(file, JSON.stringify([{ pid: "nope" }, record(3, 30), null]))
    expect(readRegistry(file)).toEqual([record(3, 30)])
  })
})

describe("reapOrphanServers", () => {
  it("kills a server whose owning extension host is dead", async () => {
    const file = tmpRegistry()
    recordServer(file, record(50, 40))
    const terminate = vi.fn()
    const killed = await reapOrphanServers(file, OWN_PID, ops({ isAlive: (pid) => pid !== 40, terminate }))
    expect(killed).toEqual([50])
    expect(terminate).toHaveBeenCalledWith(50)
    // Record stays so a SIGTERM-ignorer is retried next activation; the
    // dead-pid branch drops it once the process is actually gone.
    expect(readRegistry(file)).toEqual([record(50, 40)])
  })

  it("leaves another live window's server alone", async () => {
    const file = tmpRegistry()
    recordServer(file, record(50, 40))
    const terminate = vi.fn()
    const killed = await reapOrphanServers(file, OWN_PID, ops({ terminate }))
    expect(killed).toEqual([])
    expect(terminate).not.toHaveBeenCalled()
    expect(readRegistry(file)).toEqual([record(50, 40)])
  })

  it("keeps records owned by the current extension host untouched", async () => {
    const file = tmpRegistry()
    recordServer(file, record(50, OWN_PID))
    const terminate = vi.fn()
    await reapOrphanServers(file, OWN_PID, ops({ isAlive: () => false, terminate }))
    expect(terminate).not.toHaveBeenCalled()
    expect(readRegistry(file)).toEqual([record(50, OWN_PID)])
  })

  it("drops a dead server's entry without killing anything", async () => {
    const file = tmpRegistry()
    recordServer(file, record(50, 40))
    const terminate = vi.fn()
    const killed = await reapOrphanServers(file, OWN_PID, ops({ isAlive: () => false, terminate }))
    expect(killed).toEqual([])
    expect(terminate).not.toHaveBeenCalled()
    expect(readRegistry(file)).toEqual([])
  })

  it("never kills a reused pid whose command line is not opencode serve", async () => {
    const file = tmpRegistry()
    recordServer(file, record(50, 40))
    const terminate = vi.fn()
    const killed = await reapOrphanServers(
      file,
      OWN_PID,
      ops({ isAlive: (pid) => pid !== 40, commandOf: async () => "/usr/bin/vim notes.txt", terminate }),
    )
    expect(killed).toEqual([])
    expect(terminate).not.toHaveBeenCalled()
    expect(readRegistry(file)).toEqual([])
  })

  it("keeps the record for retry when the command lookup fails, rather than kill blind", async () => {
    const file = tmpRegistry()
    recordServer(file, record(50, 40))
    const terminate = vi.fn()
    const killed = await reapOrphanServers(
      file,
      OWN_PID,
      ops({ isAlive: (pid) => pid !== 40, commandOf: async () => undefined, terminate }),
    )
    expect(killed).toEqual([])
    expect(terminate).not.toHaveBeenCalled()
    expect(readRegistry(file)).toEqual([record(50, 40)])
  })

  it("keeps the record when terminate throws", async () => {
    const file = tmpRegistry()
    recordServer(file, record(50, 40))
    const killed = await reapOrphanServers(
      file,
      OWN_PID,
      ops({
        isAlive: (pid) => pid !== 40,
        terminate: () => {
          throw new Error("EPERM")
        },
      }),
    )
    expect(killed).toEqual([])
    expect(readRegistry(file)).toEqual([record(50, 40)])
  })

  it("handles a mixed registry in one pass", async () => {
    const file = tmpRegistry()
    recordServer(file, record(50, 40)) // orphan → kill
    recordServer(file, record(60, 41)) // owner alive → keep
    recordServer(file, record(70, 42)) // server dead → drop
    const terminate = vi.fn()
    const killed = await reapOrphanServers(
      file,
      OWN_PID,
      ops({ isAlive: (pid) => pid !== 40 && pid !== 42 && pid !== 70, terminate }),
    )
    expect(killed).toEqual([50])
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(readRegistry(file)).toEqual([record(50, 40), record(60, 41)])
  })
})
