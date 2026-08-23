import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

export type ServerRecord = {
  pid: number
  /** Extension-host pid that spawned the server; a dead owner marks it orphaned. */
  ownerPid: number
  startedAt: number
}

export function registryPath(globalStorageDir: string): string {
  return path.join(globalStorageDir, "opencode-servers.json")
}

export function readRegistry(file: string): ServerRecord[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (r): r is ServerRecord =>
        !!r &&
        typeof (r as ServerRecord).pid === "number" &&
        typeof (r as ServerRecord).ownerPid === "number" &&
        typeof (r as ServerRecord).startedAt === "number",
    )
  } catch {
    return []
  }
}

function writeRegistry(file: string, records: ServerRecord[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(records))
}

export function recordServer(file: string, record: ServerRecord): void {
  const rest = readRegistry(file).filter((r) => r.pid !== record.pid)
  writeRegistry(file, [...rest, record])
}

export function releaseServer(file: string, pid: number): void {
  writeRegistry(file, readRegistry(file).filter((r) => r.pid !== pid))
}

export type ProcessOps = {
  isAlive(pid: number): boolean
  /** Full command line of the process, or undefined when the lookup failed. */
  commandOf(pid: number): Promise<string | undefined>
  terminate(pid: number): void
}

export function defaultProcessOps(): ProcessOps {
  return {
    isAlive(pid) {
      try {
        process.kill(pid, 0)
        return true
      } catch (e) {
        // EPERM = alive but owned by someone else.
        return (e as NodeJS.ErrnoException).code === "EPERM"
      }
    },
    async commandOf(pid) {
      try {
        if (os.platform() === "win32") {
          const { stdout } = await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
          ])
          return stdout.trim() || undefined
        }
        const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="])
        return stdout.trim() || undefined
      } catch {
        return undefined
      }
    },
    terminate(pid) {
      process.kill(pid)
    },
  }
}

/**
 * Kill servers recorded by extension hosts that no longer exist. A debugger
 * Stop (or a host crash) skips deactivate, and opencode has no parent-death
 * watchdog of its own — it ignores stdin EOF — so the orphaned server would
 * otherwise hold its port forever. Runs at every activation. Returns the
 * pids terminated.
 */
export async function reapOrphanServers(
  file: string,
  ownPid: number,
  ops: ProcessOps = defaultProcessOps(),
): Promise<number[]> {
  const records = readRegistry(file)
  if (!records.length) return []
  const kept: ServerRecord[] = []
  const killed: number[] = []
  for (const record of records) {
    if (record.ownerPid === ownPid) {
      kept.push(record)
      continue
    }
    // Server already gone — just drop the stale entry.
    if (!ops.isAlive(record.pid)) continue
    // Owner alive: another window's healthy server, leave it alone.
    if (ops.isAlive(record.ownerPid)) {
      kept.push(record)
      continue
    }
    const command = await ops.commandOf(record.pid)
    // Can't verify what the pid is now — keep the record and retry next
    // activation rather than kill blind.
    if (command === undefined) {
      kept.push(record)
      continue
    }
    // Pid reused by an unrelated process — drop the entry, never kill.
    if (!command.includes("opencode") || !command.includes("serve")) continue
    try {
      ops.terminate(record.pid)
      killed.push(record.pid)
      // Keep the record: if the server ignored SIGTERM the next activation
      // retries; if it died, the dead-pid branch drops it then.
      kept.push(record)
    } catch {
      kept.push(record)
    }
  }
  writeRegistry(file, kept)
  return killed
}
