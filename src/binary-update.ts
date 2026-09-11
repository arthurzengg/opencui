import { execFile } from "child_process"
import { resolveSpawnTarget } from "./server"
import { log } from "./output"

const DEFAULT_MIN_INTERVAL_MS = 5 * 60_000

/** First semver-looking token in `opencode --version` output. */
export function parseVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0]
}

/** Version of the opencode binary on disk, or undefined when it cannot be run. */
export function readBinaryVersion(binaryPath: string, timeoutMs = 5000): Promise<string | undefined> {
  const target = resolveSpawnTarget(binaryPath)
  return new Promise((resolve) => {
    execFile(
      target.command,
      ["--version"],
      { shell: target.shell, timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) {
          log("opencode --version failed", err)
          resolve(undefined)
          return
        }
        resolve(parseVersion(String(stdout)))
      },
    )
  })
}

export type BinaryUpdateDeps = {
  /** Version the running server reports; undefined when no server is up. */
  runningVersion: () => string | undefined
  /** Version of the binary on disk; undefined when it cannot be read. */
  readVersion: () => Promise<string | undefined>
  /** Resolves true when the user chose to restart. */
  offerRestart: (installed: string, running: string) => Promise<boolean>
  restart: () => Promise<void>
  now?: () => number
  minIntervalMs?: number
}

/**
 * opencode upgraded on disk leaves the spawned server on the old version
 * until it is restarted, and the server never announces that itself:
 * `installation.updated` only fires from its own upgrade route and from the
 * TUI's auto-upgrade, neither of which `opencode serve` runs (#615).
 */
export class BinaryUpdateWatch {
  private lastCheck = -Infinity
  private inFlight: Promise<void> | undefined
  private offered = new Set<string>()

  constructor(private readonly deps: BinaryUpdateDeps) {}

  /** Cheap to call on every interaction; runs the binary at most once per interval. */
  check(): Promise<void> {
    if (this.inFlight) return this.inFlight
    const running = this.deps.runningVersion()
    if (!running) return Promise.resolve()
    const now = (this.deps.now ?? Date.now)()
    if (now - this.lastCheck < (this.deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)) return Promise.resolve()
    this.lastCheck = now
    this.inFlight = this.run(running).finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  private async run(running: string): Promise<void> {
    try {
      const installed = await this.deps.readVersion()
      if (!installed || installed === running || this.offered.has(installed)) return
      this.offered.add(installed)
      if (await this.deps.offerRestart(installed, running)) await this.deps.restart()
    } catch (e) {
      log("binary update check failed", e)
    }
  }
}
