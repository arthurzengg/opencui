import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AgentInfo, CommandInfo, CredentialEntry, IntegrationAttemptStatus, IntegrationInfo, McpServer, ModelInfo, ProviderInfo, SessionActive, SessionInfo, SessionMessageInfo } from "@opencode/client/promise"

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
  /** What the active route answers: the sessions the server is running. */
  active: Record<string, SessionActive>
  messages: Record<string, SessionMessageInfo[]>
  models: ModelInfo[]
  providers: ProviderInfo[]
  agents: AgentInfo[]
  commands: CommandInfo[]
  mcp: McpServer[]
  integrations: IntegrationInfo[]
  credentials: CredentialEntry[]
  /** What the OAuth status route answers; tests set it before polling. */
  oauthStatus: IntegrationAttemptStatus
  /** Every request that reached the server, after the auth check. */
  requests: Array<{ method: string; path: string; query: Record<string, string>; body?: unknown }>
  push: (event: Record<string, unknown>) => void
  /** Resolves once an SSE client is connected. */
  awaitClient: () => Promise<void>
  close: () => Promise<void>
}

export async function startMockOpencodeV2(password = "test-password"): Promise<MockOpencodeV2> {
  // The handler reads through the returned object, so a test can replace
  // whole fixture arrays after start.
  const state = {
    url: "",
    password,
    sessions: [],
    active: {} as Record<string, SessionActive>,
    messages: {},
    models: [],
    providers: [],
    agents: [],
    commands: [],
    mcp: [],
    integrations: [] as IntegrationInfo[],
    credentials: [] as CredentialEntry[],
    oauthStatus: { status: "complete", time: { created: 0, expires: 0 } } as IntegrationAttemptStatus,
    requests: [],
    // Events pushed before a client connects wait for the first one, as
    // the 1.x mock does, so a test never races the subscription.
    push: (event: Record<string, unknown>) => {
      const frame = `data: ${JSON.stringify(event)}\n\n`
      if (sse.length === 0) pending.push(frame)
      for (const res of sse) res.write(frame)
    },
    awaitClient: () => (sse.length > 0 ? Promise.resolve() : new Promise<void>((resolve) => clientWaiters.push(resolve))),
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of sse) res.end()
        server.close(() => resolve())
      }),
  } satisfies MockOpencodeV2
  const expectedAuth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const sse: ServerResponse[] = []
  const pending: string[] = []
  let clientWaiters: Array<() => void> = []

  const empty = (res: ServerResponse) => {
    res.statusCode = 204
    res.end()
  }
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(body))
  }

  function handle(req: IncomingMessage, res: ServerResponse) {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => route(req, res, raw))
  }

  function route(req: IncomingMessage, res: ServerResponse, raw: string) {
    const url = new URL(req.url ?? "/", "http://localhost")
    // A JSON body on failures, as the Effect-based server sends; the client
    // reports a bare status without one as an unsupported content type.
    if (req.headers.authorization !== expectedAuth) return json(res, 401, { message: "unauthorized" })
    const query = Object.fromEntries(url.searchParams)
    let body: unknown
    try {
      body = raw ? JSON.parse(raw) : undefined
    } catch {
      body = raw
    }
    state.requests.push({ method: req.method ?? "", path: url.pathname, query, ...(body !== undefined ? { body } : {}) })
    const location = { directory: query["location[directory]"] ?? "" }
    const path = url.pathname

    if (path === "/api/info") return json(res, 200, { version: "2.0.24", pid: process.pid, urls: [], paths: { tmp: "/tmp" } })
    if (path === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      res.write(`data: ${JSON.stringify({ id: "evt_0", created: Date.now(), type: "server.connected", data: {} })}\n\n`)
      for (const frame of pending.splice(0)) res.write(frame)
      sse.push(res)
      for (const resolve of clientWaiters.splice(0)) resolve()
      res.on("close", () => {
        const i = sse.indexOf(res)
        if (i >= 0) sse.splice(i, 1)
      })
      return
    }
    if (path === "/api/session/active" && req.method === "GET") return json(res, 200, { data: state.active })
    if (path === "/api/session" && req.method === "GET") {
      let rows = state.sessions
      if (query.parentID === "null") rows = rows.filter((s) => !s.parentID)
      else if (query.parentID) rows = rows.filter((s) => s.parentID === query.parentID)
      if (query.search) rows = rows.filter((s) => (s.title ?? "").toLowerCase().includes(query.search!.toLowerCase()))
      if (query.limit) rows = rows.slice(0, Number(query.limit))
      return json(res, 200, { data: rows, cursor: {} })
    }
    if (path === "/api/session" && req.method === "POST") {
      const input = (body ?? {}) as { title?: string; agent?: string; model?: SessionInfo["model"] }
      const created: SessionInfo = {
        id: `ses_${state.sessions.length + 1}`,
        projectID: "proj_mock",
        title: input.title ?? "New session",
        agent: input.agent,
        model: input.model,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now(), updated: Date.now() },
      }
      state.sessions.push(created)
      // Single-session routes answer { data } and the client unwraps it.
      return json(res, 200, { data: created })
    }
    const one = path.match(/^\/api\/session\/([^/]+)$/)
    if (one) {
      const row = state.sessions.find((s) => s.id === one[1])
      if (!row) return json(res, 404, { message: "session not found" })
      if (req.method === "GET") return json(res, 200, { data: row })
      if (req.method === "PATCH") {
        const title = (body as { title?: string } | undefined)?.title
        if (typeof title === "string") row.title = title
        return empty(res)
      }
      if (req.method === "DELETE") {
        state.sessions.splice(state.sessions.indexOf(row), 1)
        return empty(res)
      }
    }
    const instruction = path.match(/^\/api\/experimental\/session\/([^/]+)\/instructions\/entries\/([^/]+)$/)
    if (instruction && (req.method === "PUT" || req.method === "DELETE")) return empty(res)
    const action = path.match(/^\/api\/(?:experimental\/)?session\/([^/]+)\/(prompt|synthetic|model|agent|interrupt|wait|compact|fork|command|revert\/stage|revert\/commit|revert)$/)
    if (action && (req.method === "POST" || (req.method === "DELETE" && action[2] === "revert"))) {
      if (action[2] === "fork") {
        const source = state.sessions.find((s) => s.id === action[1])
        const forked: SessionInfo = { ...(source ?? { projectID: "proj_mock", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }), id: `ses_${state.sessions.length + 1}`, title: `Fork of ${source?.title ?? action[1]}`, time: { created: Date.now(), updated: Date.now() } }
        state.sessions.push(forked)
        return json(res, 200, { data: forked })
      }
      if (action[2] === "compact") return json(res, 200, { data: { id: `inbox_${state.requests.length}`, sessionID: action[1], type: "compaction" } })
      if (action[2] === "revert/stage") return json(res, 200, { data: {} })
      // Success statuses as the client expects them: the inbox routes and
      // interrupt answer a body, the switches and wait answer nothing.
      if (action[2] === "prompt") return json(res, 200, { id: `inbox_${state.requests.length}`, sessionID: action[1], time: { created: Date.now() }, type: "user", payload: body, delivery: "queue" })
      if (action[2] === "synthetic") return json(res, 200, { id: `inbox_${state.requests.length}`, sessionID: action[1], time: { created: Date.now() }, type: "synthetic", payload: body, delivery: "queue" })
      if (action[2] === "interrupt") return json(res, 200, {})
      return empty(res)
    }
    const messages = path.match(/^\/api\/session\/([^/]+)\/message$/)
    if (messages && req.method === "GET") {
      const rows = state.messages[messages[1]!]
      if (!rows) return json(res, 404, { message: "session not found" })
      return json(res, 200, { data: rows, cursor: {} })
    }
    // Replies answer 204 with no body, as the server does.
    if (/^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(path) && req.method === "POST") return empty(res)
    if (/^\/api\/session\/[^/]+\/form\/[^/]+\/reply$/.test(path) && req.method === "POST") return empty(res)
    if (/^\/api\/session\/[^/]+\/form\/[^/]+$/.test(path) && req.method === "DELETE") return empty(res)
    const mcp = path.match(/^\/api\/experimental\/mcp\/([^/]+)(?:\/(connect|disconnect))?$/)
    if (mcp) {
      const name = mcp[1]!
      if (req.method === "PUT") {
        const config = (body as { config?: { disabled?: boolean } } | undefined)?.config
        state.mcp = [...state.mcp.filter((s) => s.name !== name), { name, status: config?.disabled ? { status: "disabled" } : { status: "connected" } }]
        return empty(res)
      }
      if (req.method === "DELETE") {
        state.mcp = state.mcp.filter((s) => s.name !== name)
        return empty(res)
      }
      if (req.method === "POST" && mcp[2]) {
        const row = state.mcp.find((s) => s.name === name)
        if (row) row.status = mcp[2] === "connect" ? { status: "connected" } : { status: "disabled" }
        return empty(res)
      }
    }
    if (path === "/api/integration") return json(res, 200, { location, data: state.integrations })
    const connect = path.match(/^\/api\/integration\/([^/]+)\/connect\/(key|oauth)(?:\/([^/]+))?(\/complete)?$/)
    if (connect) {
      const integration = state.integrations.find((i) => i.id === connect[1])
      if (!integration) return json(res, 404, { message: "integration not found" })
      if (connect[2] === "key" && req.method === "POST") {
        const id = `cred_${state.credentials.length + 1}`
        state.credentials.push({ id, integrationID: integration.id, label: "API key", active: true, value: { type: "key" } as CredentialEntry["value"] })
        integration.connections.push({ type: "credential", id, label: "API key", method: "key" })
        return empty(res)
      }
      if (connect[2] === "oauth" && !connect[3] && req.method === "POST") {
        return json(res, 200, { location, data: { attemptID: "att_1", url: "https://auth.example/start", instructions: "Finish in the browser", mode: "auto", time: { created: 0, expires: 0 } } })
      }
      if (connect[3] && req.method === "GET") return json(res, 200, { location, data: state.oauthStatus })
      if (connect[3] && connect[4] && req.method === "POST") return empty(res)
      if (connect[3] && req.method === "DELETE") return empty(res)
    }
    if (path === "/api/credential" && req.method === "GET") return json(res, 200, { data: state.credentials })
    const credential = path.match(/^\/api\/credential\/([^/]+)$/)
    if (credential && req.method === "DELETE") {
      state.credentials = state.credentials.filter((c) => c.id !== credential[1])
      for (const i of state.integrations) i.connections = i.connections.filter((c) => c.type !== "credential" || c.id !== credential[1])
      return empty(res)
    }
    if (path === "/api/location/reload" && req.method === "POST") return empty(res)
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
