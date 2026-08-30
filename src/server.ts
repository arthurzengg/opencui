import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"
import { log } from "./output"
import { primaryWorkspaceRoot, type WorkspaceRoot } from "./workspace-root"
import { recordServer, registryPath, releaseServer } from "./server-registry"

const SERVER_START_TIMEOUT_MS = 60000

export type OpencodeConfigMode = "isolated" | "user"

type ServerHandle = {
  url: string
  pid?: number
  close(): void
  /** Register a callback fired if the process exits AFTER successful startup. */
  onExit(listener: () => void): void
}

export type Backend = {
  url: string
  client: OpencodeClient
  directory: string
  /**
   * Workspace root the server was bound to at start time. Undefined when no
   * folder was open — callers should treat that as "no automatic context"
   * and avoid running git/find/etc. against an unknown cwd.
   */
  workspace?: WorkspaceRoot
  /** Active opencode config-mode for this server lifecycle. */
  configMode: OpencodeConfigMode
}

export class ServerManager {
  private server: ServerHandle | undefined
  private client: OpencodeClient | undefined
  private starting: Promise<Backend> | undefined
  /** Cancels the in-flight start attempt so restart/dispose mid-startup is not a no-op (#581). */
  private startAbort: AbortController | undefined
  /** Workspace root captured at start time so subsequent `ensure()` calls return a stable Backend. */
  private workspace: WorkspaceRoot | undefined
  private configMode: OpencodeConfigMode = "isolated"

  constructor(private context: vscode.ExtensionContext) {}

  async ensure(): Promise<Backend> {
    if (this.server && this.client) {
      return this.toBackend(this.server, this.client)
    }
    if (this.starting) return this.starting
    const abort = new AbortController()
    const attempt = this.startInternal(abort.signal).finally(() => {
      // dispose() may have already detached this attempt and a successor may
      // be starting — only clear the slots that still belong to it.
      if (this.starting === attempt) {
        this.starting = undefined
        this.startAbort = undefined
      }
    })
    this.starting = attempt
    this.startAbort = abort
    return attempt
  }

  private async startInternal(signal: AbortSignal): Promise<Backend> {
    const config = vscode.workspace.getConfiguration("opencui")
    const port = config.get<number>("serverPort") ?? 0
    const configuredBinaryPath = config.get<string>("binaryPath") || "opencode"
    const binaryPath = resolveBinaryPath(configuredBinaryPath, this.context.extensionPath)
    const configMode = readConfigMode(config)
    const workspace = primaryWorkspaceRoot()

    log("starting opencode server", {
      configuredBinaryPath,
      resolved: binaryPath,
      port,
      configMode,
      workspace: workspace?.fsPath ?? "(no workspace)",
    })
    let spawnedPid: number | undefined
    let server: ServerHandle
    try {
      server = await startOpencodeServer(binaryPath, {
        hostname: "127.0.0.1",
        port: port || randomPort(),
        timeout: SERVER_START_TIMEOUT_MS,
        cwd: workspace?.fsPath,
        configMode,
        signal,
        // Registered at spawn, not at ready: an extension host killed during
        // the 60s startup window must still leave a reapable record.
        onSpawn: (pid) => {
          spawnedPid = pid
          this.updateRegistry((file) =>
            recordServer(file, { pid, ownerPid: process.pid, startedAt: Date.now() }),
          )
        },
      })
    } catch (e) {
      if (spawnedPid !== undefined) {
        const pid = spawnedPid
        this.updateRegistry((file) => releaseServer(file, pid))
      }
      throw e
    }
    log("opencode server ready at", server.url)
    const client = createOpencodeClient({
      baseUrl: server.url,
      directory: workspace?.fsPath ?? process.cwd(),
    })
    this.server = server
    this.client = client
    this.workspace = workspace
    this.configMode = configMode
    server.onExit(() => {
      // Only invalidate if this handle is still the active one — a crash
      // notification from a server we already replaced (restart/dispose)
      // must not clobber its successor.
      if (this.server !== server) return
      log("opencode server exited unexpectedly; clearing cached backend")
      if (server.pid !== undefined) this.updateRegistry((file) => releaseServer(file, server.pid!))
      this.server = undefined
      this.client = undefined
      this.workspace = undefined
    })
    return this.toBackend(server, client)
  }

  async restart(): Promise<Backend> {
    await this.dispose()
    return this.ensure()
  }

  async dispose() {
    const starting = this.starting
    if (starting) {
      // A start is still in flight: abort it (killing the spawned child via
      // the startOpencodeServer fail path) and wait for it to settle. If it
      // wins the photo-finish and installs itself instead, the settle
      // happens-before the block below, which tears it down normally.
      // Without this, restart() mid-startup returned the OLD in-flight
      // attempt with the old settings (#581).
      log("cancelling in-flight opencode server start")
      this.startAbort?.abort()
      this.starting = undefined
      this.startAbort = undefined
      await starting.catch(() => {})
    }
    if (this.server) {
      log("stopping opencode server")
      this.server.close()
      if (this.server.pid !== undefined) {
        const pid = this.server.pid
        this.updateRegistry((file) => releaseServer(file, pid))
      }
      this.server = undefined
      this.client = undefined
      this.workspace = undefined
    }
  }

  /** Registry writes are best-effort — a broken storage dir must never take the server down. */
  private updateRegistry(fn: (file: string) => void): void {
    const dir = this.context.globalStorageUri?.fsPath
    if (!dir) return
    try {
      fn(registryPath(dir))
    } catch (e) {
      log("server registry update failed", e)
    }
  }

  /** Workspace the running server is bound to, or undefined if not started yet. */
  currentWorkspace(): WorkspaceRoot | undefined {
    return this.workspace
  }

  /**
   * The already-running backend, or undefined if none — never spawns one.
   * For best-effort callers (e.g. stale-task reconciliation on conversation
   * switch) that should stay silent rather than cold-start a server.
   */
  currentBackend(): Backend | undefined {
    if (!this.server || !this.client) return undefined
    return this.toBackend(this.server, this.client)
  }

  private toBackend(server: ServerHandle, client: OpencodeClient): Backend {
    return {
      url: server.url,
      client,
      directory: this.workspace?.fsPath ?? process.cwd(),
      workspace: this.workspace,
      configMode: this.configMode,
    }
  }
}

function randomPort() {
  return Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
}

function readConfigMode(config: vscode.WorkspaceConfiguration): OpencodeConfigMode {
  const value = config.get<string>("opencodeConfigMode")
  return value === "user" ? "user" : "isolated"
}

function resolveBinaryPath(binaryPath: string, extensionPath: string): string {
  // Absolute path → use as-is (lets dev override via settings.json).
  if (path.isAbsolute(binaryPath)) return binaryPath
  // Anything other than the literal "opencode" → resolve relative to the
  // extension install dir (lets us point at a non-default bundled name).
  if (binaryPath !== "opencode") return path.join(extensionPath, binaryPath)
  // Default path: prefer a bundled binary if shipped with the extension,
  // fall back to the literal "opencode" so it resolves via $PATH.
  const bundled = bundledBinaryPath(extensionPath)
  return bundled ?? "opencode"
}

function bundledBinaryPath(extensionPath: string): string | undefined {
  // The published `opencode-ai` npm package exposes a Node.js shim at
  // `bin/opencode` that routes to the platform-specific binary at runtime.
  // If this is bundled into the extension via npm dependency, we use it.
  const candidate = path.join(extensionPath, "node_modules", "opencode-ai", "bin", "opencode")
  try {
    require("fs").accessSync(candidate, require("fs").constants.X_OK)
    return candidate
  } catch {
    return undefined
  }
}

export type SpawnTarget = {
  command: string
  /** Route through cmd.exe — required for the .cmd/.bat shims npm installs. */
  shell: boolean
}

/**
 * What to actually hand `spawn`. On Windows, CreateProcess resolves a bare
 * "opencode" only to an .exe, and a .cmd/.bat shim cannot be spawned
 * directly at all (EINVAL since the CVE-2024-27980 hardening) — yet
 * `npm install -g opencode-ai` ships exactly such a shim (#548). Walk PATH
 * ourselves: the first entry with a match wins (what cmd.exe would run),
 * a real .exe inside it beats the shim (clean pid, clean kill), and a shim
 * runs through the shell, quoted against spaces in the path.
 */
export function resolveSpawnTarget(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (candidate: string) => boolean = (candidate) => {
    try {
      return fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  },
): SpawnTarget {
  if (platform !== "win32") return { command: binaryPath, shell: false }
  if (/\.(cmd|bat)$/i.test(binaryPath)) return { command: `"${binaryPath}"`, shell: true }
  // Explicit path to anything else (.exe, extensionless) → spawn directly.
  if (path.win32.basename(binaryPath) !== binaryPath) return { command: binaryPath, shell: false }
  for (const dir of (env.PATH ?? env.Path ?? "").split(";").filter(Boolean)) {
    const exe = path.win32.join(dir, `${binaryPath}.exe`)
    if (fileExists(exe)) return { command: exe, shell: false }
    for (const ext of [".cmd", ".bat"]) {
      const shim = path.win32.join(dir, binaryPath + ext)
      if (fileExists(shim)) return { command: `"${shim}"`, shell: true }
    }
  }
  return { command: binaryPath, shell: false }
}

export function startOpencodeServer(
  binaryPath: string,
  options: {
    hostname: string
    port: number
    timeout: number
    /** Workspace root for the subprocess `cwd`. Undefined means inherit. */
    cwd?: string
    configMode: OpencodeConfigMode
    /** Fired with the child pid immediately after spawn. */
    onSpawn?: (pid: number) => void
    /** Aborting rejects the startup promise and kills the spawned child. */
    signal?: AbortSignal
  },
): Promise<ServerHandle> {
  if (options.signal?.aborted) {
    return Promise.reject(new Error("opencode server start cancelled"))
  }
  // `isolated` keeps the historical behavior: hand opencode an empty config so
  // the user's `~/.config/opencode` and any local config/plugins are ignored —
  // gives the extension predictable defaults. `user` opts back in to the
  // user's normal opencode environment (config, agents, plugins).
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (options.configMode === "isolated") {
    env.OPENCODE_CONFIG_CONTENT = "{}"
  } else {
    delete env.OPENCODE_CONFIG_CONTENT
  }
  const target = resolveSpawnTarget(binaryPath)
  const proc = spawn(target.command, ["serve", `--hostname=${options.hostname}`, `--port=${options.port}`], {
    cwd: options.cwd,
    env,
    shell: target.shell,
  })
  if (proc.pid !== undefined) options.onSpawn?.(proc.pid)

  return new Promise((resolve, reject) => {
    let output = ""
    let settled = false
    let started = false
    const exitListeners: Array<() => void> = []
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      closeProcess(proc)
      reject(new Error(`Timeout waiting for server to start after ${options.timeout}ms${formatServerOutput(output)}`))
    }, options.timeout)

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      closeProcess(proc)
      reject(error)
    }

    options.signal?.addEventListener(
      "abort",
      () => fail(new Error("opencode server start cancelled")),
      { once: true },
    )

    proc.stdout.on("data", (chunk) => {
      if (settled) return
      output += chunk.toString()
      for (const line of output.split("\n")) {
        if (!stripAnsi(line).startsWith("opencode server listening")) continue
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
        if (!match?.[1]) {
          fail(new Error(`Failed to parse server url from output: ${line}`))
          return
        }
        settled = true
        started = true
        clearTimeout(timer)
        resolve({
          url: match[1],
          pid: proc.pid,
          close: () => closeProcess(proc),
          onExit: (listener) => exitListeners.push(listener),
        })
        return
      }
    })

    proc.stderr.on("data", (chunk) => {
      output += chunk.toString()
    })
    proc.on("error", fail)
    proc.on("exit", (code) => {
      if (!settled) {
        fail(new Error(`Server exited with code ${code}${formatServerOutput(output)}`))
        return
      }
      if (!started) return
      log(`opencode server process exited (code ${code})`)
      for (const listener of exitListeners) listener()
    })
  })
}

function formatServerOutput(output: string) {
  const trimmed = output.trim()
  if (!trimmed) return "\nServer output: (none)"
  const lines = trimmed.split("\n")
  return `\nServer output:\n${lines.slice(-40).join("\n")}`
}

function stripAnsi(value: string) {
  return value.replace(/\x1b\[[0-9;]*m/g, "")
}

function closeProcess(proc: ChildProcessWithoutNullStreams) {
  if (proc.killed || proc.exitCode !== null) return
  if (process.platform === "win32" && proc.pid !== undefined) {
    // No ladder on Windows: proc.kill() is already a hard TerminateProcess,
    // and when the spawn went through cmd.exe (npm's .cmd shim, #548) it
    // would kill only the shell and orphan the server — taskkill takes the
    // whole tree down.
    const killer = spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { stdio: "ignore" })
    killer.once("error", () => proc.kill())
    killer.unref()
    return
  }
  // MCP-style shutdown ladder: stdin EOF first (so an opencode that learns
  // the convention exits cleanly), SIGTERM now, SIGKILL only if it lingers.
  try {
    proc.stdin.end()
  } catch {
    // stream already closed
  }
  proc.kill()
  const hardKill = setTimeout(() => {
    if (proc.exitCode === null) proc.kill("SIGKILL")
  }, 3000)
  hardKill.unref?.()
  proc.once("exit", () => clearTimeout(hardKill))
}
