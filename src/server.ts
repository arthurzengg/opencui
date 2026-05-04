import * as vscode from "vscode"
import { createOpencodeServer, createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"
import { log } from "./output"

type ServerHandle = Awaited<ReturnType<typeof createOpencodeServer>>

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

    log("starting opencode server", { port })
    const server = await createOpencodeServer({
      hostname: "127.0.0.1",
      port: port || randomPort(),
      timeout: 15000,
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
