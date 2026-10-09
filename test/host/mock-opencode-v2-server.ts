import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AgentInfo, CommandInfo, McpServer, ModelInfo, ProviderInfo, SessionInfo, SessionMessageInfo } from "@opencode/client/promise"

/**
 * The slice of an opencode 2.0 server the adapter reads (#693): Basic auth
 * with the password the server was started with, the info route, session
 * and message listing, the catalogs, and the SSE event feed. Routes and
 * query shapes were recorded from @opencode/client 2.0.24.
 */
export type MockOpencodeV2 = {
  url: string
  password: string
  sessions: SessionInfo[]
  messages: Record<string, SessionMessageInfo[]>
  models: ModelInfo[]
  providers: ProviderInfo[]
  agents: AgentInfo[]
  commands: CommandInfo[]
  mcp: McpServer[]
  /** Every request that reached the server, after the auth check. */
  requests: Array<{ method: string; path: string; query: Record<string, string> }>
  push: (event: Record<string, unknown>) => void
  close: () => Promise<void>
}

export async function startMockOpencodeV2(password = "test-password"): Promise<MockOpencodeV2> {
  // The handler reads through the returned object, so a test can replace
  // whole fixture arrays after start.
  const state = {
    url: "",
    password,
    sessions: [],
    messages: {},
    models: [],
    providers: [],
    agents: [],
    commands: [],
    mcp: [],
    requests: [],
    push: (event: Record<string, unknown>) => {
      for (const res of sse) res.write(`data: ${JSON.stringify(event)}\n\n`)
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of sse) res.end()
        server.close(() => resolve())
      }),
  } satisfies MockOpencodeV2
  const expectedAuth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const sse: ServerResponse[] = []

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(body))
  }

  function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost")
    // A JSON body on failures, as the Effect-based server sends; the client
    // reports a bare status without one as an unsupported content type.
    if (req.headers.authorization !== expectedAuth) return json(res, 401, { message: "unauthorized" })
    const query = Object.fromEntries(url.searchParams)
    state.requests.push({ method: req.method ?? "", path: url.pathname, query })
    const location = { directory: query["location[directory]"] ?? "" }
    const path = url.pathname

    if (path === "/api/info") return json(res, 200, { version: "2.0.24", pid: process.pid, urls: [], paths: { tmp: "/tmp" } })
    if (path === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      res.write(`data: ${JSON.stringify({ id: "evt_0", created: Date.now(), type: "server.connected", data: {} })}\n\n`)
      sse.push(res)
      res.on("close", () => {
        const i = sse.indexOf(res)
        if (i >= 0) sse.splice(i, 1)
      })
      return
    }
    if (path === "/api/session" && req.method === "GET") {
      let rows = state.sessions
      if (query.parentID === "null") rows = rows.filter((s) => !s.parentID)
      else if (query.parentID) rows = rows.filter((s) => s.parentID === query.parentID)
      if (query.search) rows = rows.filter((s) => (s.title ?? "").toLowerCase().includes(query.search!.toLowerCase()))
      if (query.limit) rows = rows.slice(0, Number(query.limit))
      return json(res, 200, { data: rows, cursor: {} })
    }
    const messages = path.match(/^\/api\/session\/([^/]+)\/message$/)
    if (messages && req.method === "GET") {
      const rows = state.messages[messages[1]!]
      if (!rows) return json(res, 404, { message: "session not found" })
      return json(res, 200, { data: rows, cursor: {} })
    }
    if (path === "/api/model") return json(res, 200, { location, data: state.models })
    if (path === "/api/provider") return json(res, 200, { location, data: state.providers })
    if (path === "/api/agent") return json(res, 200, { location, data: state.agents })
    if (path === "/api/command") return json(res, 200, { location, data: state.commands })
    if (path === "/api/mcp") return json(res, 200, { location, data: state.mcp })
    res.statusCode = 404
    res.end()
  }

  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  state.url = `http://127.0.0.1:${port}`
  return state
}
