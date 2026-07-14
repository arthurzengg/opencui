/**
 * Lightweight mock of the opencode HTTP server used in E2E tests.
 *
 * It implements just enough of the surface to let `@opencode-ai/sdk` start
 * a session, send a prompt, and stream events. Tests drive the response by
 * pushing scripted events into the server's SSE stream.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http"
import { AddressInfo } from "node:net"

export type ScriptedEvent =
  | { type: "session.idle"; sessionID: string }
  | { type: "message.updated"; info: Record<string, unknown> }
  | { type: "message.part.updated"; part: Record<string, unknown> }
  | {
      type: "message.part.delta"
      sessionID: string
      messageID: string
      partID: string
      field: string
      delta: string
    }
  | { type: "session.error"; error: { name?: string; data?: { message?: string } } }
  | { type: "session.status"; sessionID: string; status: { type: string } }
  | { type: "session.created"; info: Record<string, unknown> }
  | { type: "session.updated"; info: Record<string, unknown> }

export type MockOpencodeServer = {
  url: string
  port: number
  push: (event: ScriptedEvent) => void
  /** Resolves once at least one SSE client connects. */
  awaitClient: () => Promise<void>
  /** Records of every prompt the SDK pushed to the server. */
  prompts: Array<{ sessionID: string; body: unknown }>
  /** Records of every revert call. */
  reverts: Array<{ sessionID: string; body: unknown }>
  /**
   * HTTP status POST /session/{id}/revert replies with (default 200).
   * 0 destroys the socket without replying, so the client-side call throws.
   */
  setRevertStatus: (status: number) => void
  /**
   * HTTP status POST /session (create) replies with (default 200).
   * 0 destroys the socket without replying, so the client-side call throws.
   */
  setSessionCreateStatus: (status: number) => void
  /**
   * HTTP status POST /session/{id}/summarize replies with (default 200).
   * 0 destroys the socket without replying, so the client-side call throws.
   */
  setSummarizeStatus: (status: number) => void
  /** Records of every unrevert (redo) call's sessionID. */
  unreverts: string[]
  /** Records of every fork call. */
  forks: Array<{ sessionID: string; body: unknown }>
  /** SessionIDs passed to POST /session/{id}/abort, in call order. */
  aborts: string[]
  /** Configure the direct children returned by GET /session/{id}/children. */
  setChildren: (parentID: string, childIDs: string[]) => void
  /** Records of every session.command call. */
  commandCalls: Array<{ sessionID: string; body: unknown }>
  /** Configure what GET /command returns. */
  setCommands: (commands: Array<Record<string, unknown>>) => void
  /**
   * Configure what GET /session/status returns. Pass `undefined` to clear
   * the entry. Tests use this to drive the watchdog's recovery path.
   */
  setSessionStatus: (sessionID: string, status: { type: "idle" | "busy" | "retry" } | undefined) => void
  /** Number of times GET /session/status has been called. */
  statusPollCount: () => number
  /** Records of every mcp.add body, and the server name for each lifecycle/auth call. */
  mcpAddCalls: Array<{ body: unknown }>
  mcpConnectCalls: string[]
  mcpDisconnectCalls: string[]
  mcpAuthenticateCalls: string[]
  mcpAuthRemoveCalls: string[]
  /** Records of every provider credential removal (DELETE /auth/{id}). */
  providerAuthRemoveCalls: string[]
  /** Toggle the DELETE /auth/{id} route off to simulate an older opencode (404). */
  setAuthRemoveSupported: (v: boolean) => void
  /** Configure what GET /mcp returns. */
  setMcpStatus: (map: Record<string, { status: string; error?: string }>) => void
  close: () => Promise<void>
}

export async function startMockOpencode(): Promise<MockOpencodeServer> {
  const sseClients: ServerResponse[] = []
  const prompts: Array<{ sessionID: string; body: unknown }> = []
  const reverts: Array<{ sessionID: string; body: unknown }> = []
  let revertStatus = 200
  let sessionCreateStatus = 200
  let summarizeStatus = 200
  const unreverts: string[] = []
  const forks: Array<{ sessionID: string; body: unknown }> = []
  const aborts: string[] = []
  const childrenByParent = new Map<string, string[]>()
  const commandCalls: Array<{ sessionID: string; body: unknown }> = []
  let commands: Array<Record<string, unknown>> = []
  const sessionStatuses = new Map<string, { type: "idle" | "busy" | "retry" }>()
  let statusPolls = 0
  let mcpStatus: Record<string, { status: string; error?: string }> = {}
  const mcpAddCalls: Array<{ body: unknown }> = []
  const mcpConnectCalls: string[] = []
  const mcpDisconnectCalls: string[] = []
  const mcpAuthenticateCalls: string[] = []
  const mcpAuthRemoveCalls: string[] = []
  const providerAuthRemoveCalls: string[] = []
  let authRemoveSupported = true
  let clientResolver: (() => void) | undefined

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res)
  })

  async function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        try {
          resolve(text ? JSON.parse(text) : undefined)
        } catch (e) {
          reject(e)
        }
      })
    })
  }

  function reply(res: ServerResponse, status: number, body: unknown) {
    res.statusCode = status
    res.setHeader("content-type", "application/json")
    res.end(body === undefined ? "" : JSON.stringify(body))
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost")
    const path = url.pathname
    if (process.env.MOCK_OPENCODE_DEBUG) console.error(`[mock] ${req.method} ${path}`)

    // SSE event stream (the SDK calls client.global.event which hits /global/event)
    if (path === "/global/event" || path === "/event") {
      res.statusCode = 200
      res.setHeader("content-type", "text/event-stream")
      res.setHeader("cache-control", "no-cache")
      res.setHeader("connection", "keep-alive")
      sseClients.push(res)
      if (clientResolver) {
        clientResolver()
        clientResolver = undefined
      }
      req.on("close", () => {
        const i = sseClients.indexOf(res)
        if (i >= 0) sseClients.splice(i, 1)
      })
      return
    }

    // App agents endpoint
    if (path === "/agent" && req.method === "GET") {
      reply(res, 200, [
        {
          name: "default",
          mode: "primary",
          builtIn: true,
          permission: { edit: "allow", bash: {} },
          tools: {},
          options: {},
        },
      ])
      return
    }

    // Providers
    if (path === "/config/providers" && req.method === "GET") {
      reply(res, 200, { providers: [], default: {} })
      return
    }

    // Custom command list
    if (path === "/command" && req.method === "GET") {
      reply(res, 200, commands)
      return
    }

    // Session create
    if (path === "/session" && req.method === "POST") {
      if (sessionCreateStatus === 0) {
        req.socket.destroy()
        return
      }
      if (sessionCreateStatus === 200) reply(res, 200, { id: "ses_test", title: "Test Session" })
      else reply(res, sessionCreateStatus, { error: "scripted session.create failure" })
      return
    }

    // Session prompt (sync) and prompt_async — both record into prompts.
    const promptMatch = path.match(/^\/session\/([^/]+)\/(?:message|prompt_async)$/)
    if (promptMatch && req.method === "POST") {
      const body = await readBody(req)
      prompts.push({ sessionID: promptMatch[1]!, body })
      res.statusCode = 204
      res.end()
      return
    }

    // Session command — runs a custom command; returns the created message.
    const commandMatch = path.match(/^\/session\/([^/]+)\/command$/)
    if (commandMatch && req.method === "POST") {
      const body = await readBody(req)
      commandCalls.push({ sessionID: commandMatch[1]!, body })
      reply(res, 200, { info: { id: "msg_cmd", role: "assistant", sessionID: commandMatch[1] }, parts: [] })
      return
    }

    // Built-in command endpoints: /compact → summarize, /init → init,
    // /share → share (POST) / unshare (DELETE).
    if (path.match(/^\/session\/[^/]+\/summarize$/) && req.method === "POST") {
      await readBody(req)
      if (summarizeStatus === 0) {
        req.socket.destroy()
        return
      }
      if (summarizeStatus === 200) reply(res, 200, true)
      else reply(res, summarizeStatus, { error: "scripted summarize failure" })
      return
    }
    if (path.match(/^\/session\/[^/]+\/init$/) && req.method === "POST") {
      await readBody(req)
      reply(res, 200, true)
      return
    }
    const shareMatch = path.match(/^\/session\/([^/]+)\/share$/)
    if (shareMatch && req.method === "POST") {
      reply(res, 200, { id: shareMatch[1], title: "Test Session", share: { url: "https://opencode.ai/s/abc123" } })
      return
    }
    if (shareMatch && req.method === "DELETE") {
      reply(res, 200, { id: shareMatch[1], title: "Test Session" })
      return
    }

    // Session revert
    const revertMatch = path.match(/^\/session\/([^/]+)\/revert$/)
    if (revertMatch && req.method === "POST") {
      const body = await readBody(req)
      reverts.push({ sessionID: revertMatch[1]!, body })
      if (revertStatus === 0) {
        req.socket.destroy()
        return
      }
      if (revertStatus === 200) reply(res, 200, { id: revertMatch[1] })
      else reply(res, revertStatus, { error: "scripted revert failure" })
      return
    }

    // Session unrevert (the /redo endpoint)
    const unrevertMatch = path.match(/^\/session\/([^/]+)\/unrevert$/)
    if (unrevertMatch && req.method === "POST") {
      unreverts.push(unrevertMatch[1]!)
      reply(res, 200, { id: unrevertMatch[1], title: "Test Session" })
      return
    }

    // Session fork (the /fork endpoint) — returns a NEW session.
    const forkMatch = path.match(/^\/session\/([^/]+)\/fork$/)
    if (forkMatch && req.method === "POST") {
      const body = await readBody(req)
      forks.push({ sessionID: forkMatch[1]!, body })
      reply(res, 200, { id: "ses_forked", title: "Forked session" })
      return
    }

    // Session abort
    const abortMatch = path.match(/^\/session\/([^/]+)\/abort$/)
    if (abortMatch && req.method === "POST") {
      aborts.push(abortMatch[1]!)
      reply(res, 200, true)
      return
    }

    // Session children — direct children only (the SDK/extension recurses).
    const childrenMatch = path.match(/^\/session\/([^/]+)\/children$/)
    if (childrenMatch && req.method === "GET") {
      const kids = (childrenByParent.get(childrenMatch[1]!) ?? []).map((id) => ({ id, parentID: childrenMatch[1] }))
      reply(res, 200, kids)
      return
    }

    // Session status (used by the watchdog recovery path)
    if (path === "/session/status" && req.method === "GET") {
      statusPolls++
      const body: Record<string, { type: string }> = {}
      for (const [sid, status] of sessionStatuses) body[sid] = status
      reply(res, 200, body)
      return
    }

    // MCP management. Order matters: the /auth/authenticate route must be
    // checked before the bare /auth route below.
    if (path === "/mcp" && req.method === "GET") {
      reply(res, 200, mcpStatus)
      return
    }
    if (path === "/mcp" && req.method === "POST") {
      const body = (await readBody(req)) as { name?: string }
      mcpAddCalls.push({ body })
      if (body?.name) mcpStatus[body.name] = { status: "connected" }
      reply(res, 200, mcpStatus)
      return
    }
    const mcpAuthenticateMatch = path.match(/^\/mcp\/([^/]+)\/auth\/authenticate$/)
    if (mcpAuthenticateMatch && req.method === "POST") {
      mcpAuthenticateCalls.push(mcpAuthenticateMatch[1]!)
      reply(res, 200, { status: "connected" })
      return
    }
    const mcpAuthMatch = path.match(/^\/mcp\/([^/]+)\/auth$/)
    if (mcpAuthMatch && req.method === "DELETE") {
      mcpAuthRemoveCalls.push(mcpAuthMatch[1]!)
      reply(res, 200, { success: true })
      return
    }
    const mcpConnectMatch = path.match(/^\/mcp\/([^/]+)\/connect$/)
    if (mcpConnectMatch && req.method === "POST") {
      mcpConnectCalls.push(mcpConnectMatch[1]!)
      reply(res, 200, true)
      return
    }
    const mcpDisconnectMatch = path.match(/^\/mcp\/([^/]+)\/disconnect$/)
    if (mcpDisconnectMatch && req.method === "POST") {
      mcpDisconnectCalls.push(mcpDisconnectMatch[1]!)
      reply(res, 200, true)
      return
    }

    // Provider credential removal — the untyped DELETE the ProviderManager
    // issues. `authRemoveSupported = false` simulates an older opencode whose
    // server lacks the route (404 → "unsupported" in removeProviderAuth).
    const authRemoveMatch = path.match(/^\/auth\/([^/]+)$/)
    if (authRemoveMatch && req.method === "DELETE") {
      if (!authRemoveSupported) {
        res.statusCode = 404
        res.end()
        return
      }
      providerAuthRemoveCalls.push(decodeURIComponent(authRemoveMatch[1]!))
      reply(res, 200, true)
      return
    }

    // Health (used by some SDK clients before connecting)
    if (path === "/" && req.method === "GET") {
      reply(res, 200, { ok: true })
      return
    }

    res.statusCode = 404
    res.end()
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    push(event) {
      // SSE format: "data: {json}\n\n"
      const line = `data: ${JSON.stringify({ type: event.type, properties: event })}\n\n`
      for (const client of sseClients) client.write(line)
    },
    awaitClient() {
      if (sseClients.length > 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        clientResolver = resolve
      })
    },
    prompts,
    reverts,
    setRevertStatus(status) {
      revertStatus = status
    },
    setSessionCreateStatus(status) {
      sessionCreateStatus = status
    },
    setSummarizeStatus(status) {
      summarizeStatus = status
    },
    unreverts,
    forks,
    aborts,
    setChildren(parentID, childIDs) {
      childrenByParent.set(parentID, childIDs)
    },
    commandCalls,
    setCommands(next) {
      commands = next
    },
    setSessionStatus(sessionID, status) {
      if (status) sessionStatuses.set(sessionID, status)
      else sessionStatuses.delete(sessionID)
    },
    statusPollCount() {
      return statusPolls
    },
    mcpAddCalls,
    mcpConnectCalls,
    mcpDisconnectCalls,
    mcpAuthenticateCalls,
    mcpAuthRemoveCalls,
    providerAuthRemoveCalls,
    setAuthRemoveSupported(v) {
      authRemoveSupported = v
    },
    setMcpStatus(map) {
      mcpStatus = map
    },
    async close() {
      for (const c of sseClients) c.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
