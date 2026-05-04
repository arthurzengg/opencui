import * as vscode from "vscode"
import * as path from "path"
import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"
import { log } from "./output"

const SERVER_START_TIMEOUT_MS = 60000

type ServerHandle = {
  url: string
  close(): void
}

export type Backend = {
  url: string
  client: OpencodeClient
  directory: string
}

export class ServerManager {
  private server: ServerHandle | undefined
  private client: OpencodeClient | undefined
  private starting: Promise<Backend> | undefined

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
    const binaryPath = config.get<string>("binaryPath") || "opencode"

    log("starting opencode server", { binaryPath, port })
    const server = await startOpencodeServer(resolveBinaryPath(binaryPath, this.context.extensionPath), {
      hostname: "127.0.0.1",
      port: port || randomPort(),
      timeout: SERVER_START_TIMEOUT_MS,
    })
    log("opencode server ready at", server.url)
    const client = createOpencodeClient({
      baseUrl: server.url,
      directory: workspaceDir(),
    })
    this.server = server
    this.client = client
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
    }
  }

  private toBackend(server: ServerHandle, client: OpencodeClient): Backend {
    return { url: server.url, client, directory: workspaceDir() }
  }
}

function randomPort() {
  return Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
}

function workspaceDir() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
}

function resolveBinaryPath(binaryPath: string, extensionPath: string) {
  if (path.isAbsolute(binaryPath) || binaryPath === "opencode") return binaryPath
  return path.join(extensionPath, binaryPath)
}

function startOpencodeServer(
  binaryPath: string,
  options: { hostname: string; port: number; timeout: number },
): Promise<ServerHandle> {
  const proc = spawn(binaryPath, ["serve", `--hostname=${options.hostname}`, `--port=${options.port}`], {
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: "{}",
    },
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
