import * as vscode from "vscode"
import * as path from "path"
import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"
import { log } from "./output"
import { primaryWorkspaceRoot, type WorkspaceRoot } from "./workspace-root"

const SERVER_START_TIMEOUT_MS = 60000

export type OpencodeConfigMode = "isolated" | "user"

type ServerHandle = {
  url: string
  close(): void
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
  /** Workspace root captured at start time so subsequent `ensure()` calls return a stable Backend. */
  private workspace: WorkspaceRoot | undefined
  private configMode: OpencodeConfigMode = "isolated"

  constructor(private context: vscode.ExtensionContext) {}

  async ensure(): Promise<Backend> {
    if (this.server && this.client) {
      return this.toBackend(this.server, this.client)
    }
    if (this.starting) return this.starting
    this.starting = this.startInternal().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async startInternal(): Promise<Backend> {
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
    const server = await startOpencodeServer(binaryPath, {
      hostname: "127.0.0.1",
      port: port || randomPort(),
      timeout: SERVER_START_TIMEOUT_MS,
      cwd: workspace?.fsPath,
      configMode,
    })
    log("opencode server ready at", server.url)
    const client = createOpencodeClient({
      baseUrl: server.url,
      directory: workspace?.fsPath ?? process.cwd(),
    })
    this.server = server
    this.client = client
    this.workspace = workspace
    this.configMode = configMode
    return this.toBackend(server, client)
  }

  async restart(): Promise<Backend> {
    await this.dispose()
    return this.ensure()
  }

  async dispose() {
    if (this.server) {
      log("stopping opencode server")
      this.server.close()
      this.server = undefined
      this.client = undefined
      this.workspace = undefined
    }
  }

  /** Workspace the running server is bound to, or undefined if not started yet. */
  currentWorkspace(): WorkspaceRoot | undefined {
    return this.workspace
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

function startOpencodeServer(
  binaryPath: string,
  options: {
    hostname: string
    port: number
    timeout: number
    /** Workspace root for the subprocess `cwd`. Undefined means inherit. */
    cwd?: string
    configMode: OpencodeConfigMode
  },
): Promise<ServerHandle> {
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
  const proc = spawn(binaryPath, ["serve", `--hostname=${options.hostname}`, `--port=${options.port}`], {
    cwd: options.cwd,
    env,
  })

  return new Promise((resolve, reject) => {
    let output = ""
    let settled = false
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
        clearTimeout(timer)
        resolve({
          url: match[1],
          close: () => closeProcess(proc),
        })
        return
      }
    })

    proc.stderr.on("data", (chunk) => {
      output += chunk.toString()
    })
    proc.on("error", fail)
    proc.on("exit", (code) => {
      if (settled) return
      fail(new Error(`Server exited with code ${code}${formatServerOutput(output)}`))
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
  if (proc.killed) return
  proc.kill()
}
