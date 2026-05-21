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
   * Configure what GET /session/status returns. Pass `undefined` to clear
   * the entry. Tests use this to drive the watchdog's recovery path.
   */
  setSessionStatus: (sessionID: string, status: { type: "idle" | "busy" | "retry" } | undefined) => void
  /** Number of times GET /session/status has been called. */
  statusPollCount: () => number
  close: () => Promise<void>
}

export async function startMockOpencode(): Promise<MockOpencodeServer> {
  const sseClients: ServerResponse[] = []
  const prompts: Array<{ sessionID: string; body: unknown }> = []
  const reverts: Array<{ sessionID: string; body: unknown }> = []
  const sessionStatuses = new Map<string, { type: "idle" | "busy" | "retry" }>()
  let statusPolls = 0
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

    // Session create
    if (path === "/session" && req.method === "POST") {
      reply(res, 200, { id: "ses_test", title: "Test Session" })
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

    // Session revert
    const revertMatch = path.match(/^\/session\/([^/]+)\/revert$/)
    if (revertMatch && req.method === "POST") {
      const body = await readBody(req)
      reverts.push({ sessionID: revertMatch[1]!, body })
      reply(res, 200, { id: revertMatch[1] })
      return
    }

    // Session abort
    if (path.match(/^\/session\/[^/]+\/abort$/) && req.method === "POST") {
      reply(res, 200, true)
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
    setSessionStatus(sessionID, status) {
      if (status) sessionStatuses.set(sessionID, status)
      else sessionStatuses.delete(sessionID)
    },
    statusPollCount() {
      return statusPolls
    },
    async close() {
      for (const c of sseClients) c.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
