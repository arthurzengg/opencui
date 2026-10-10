import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createV2Api } from "../../src/backend/v2/api"
import { startMockOpencodeV2, type MockOpencodeV2 } from "./mock-opencode-v2-server"

let server: MockOpencodeV2

beforeEach(async () => {
  server = await startMockOpencodeV2()
  server.sessions = [
    { id: "ses_root", projectID: "p", title: "Root chat", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 10, idle: 10 } },
    { id: "ses_child", projectID: "p", parentID: "ses_root", title: "Worker", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 2, updated: 20 } },
    { id: "ses_other", projectID: "p", title: "Other", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 3, updated: 30 }, outcome: "succeeded" },
  ]
  server.messages.ses_root = [
    { type: "user", id: "u1", time: { created: 1 }, text: "hi" },
    { type: "assistant", id: "a1", time: { created: 2, completed: 3 }, agent: "build", model: { id: "m", providerID: "p" }, content: [{ type: "text", text: "hello" }] },
  ]
  server.models = [{ id: "p/m", modelID: "m", providerID: "p", name: "M", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "high" }], time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 1000, output: 100 } }]
  server.providers = [{ id: "p", name: "Provider P", activation: "enabled", package: "pkg" }]
  server.agents = [{ id: "build", name: "build", mode: "primary", hidden: false, request: { settings: {}, headers: {} }, permissions: [] }]
  server.commands = [{ name: "review" }]
  server.mcp = [{ name: "github", status: { status: "connected" } }]
})
afterEach(async () => {
  await server.close()
})

const api = (password = server.password) => createV2Api({ url: server.url, directory: "/ws", password })

describe("opencode 2.0 adapter (#693)", () => {
  it("authenticates with the start password and reports the version as health", async () => {
    const res = await api().health()
    expect(res.data).toEqual({ healthy: true, version: "2.0.24" })
    expect(res.status).toBe(200)
  })

  // Statuses an endpoint declares come back decoded from the body, without
  // the number; the server's message is what the host can show.
  it("surfaces a wrong password as the server's error", async () => {
    const res = await api("wrong").health()
    expect(res.data).toBeUndefined()
    expect(String((res.error as Error).message)).toContain("unauthorized")
  })

  it("lists root sessions with the directory and the filters, and children by parent", async () => {
    const roots = await api().session.list({ roots: true, limit: 10, search: "chat" })
    expect(roots.data?.map((s) => s.id)).toEqual(["ses_root"])
    expect(server.requests.at(-1)).toMatchObject({ path: "/api/session", query: { directory: "/ws", parentID: "null", limit: "10", search: "chat" } })
    const children = await api().session.children("ses_root")
    expect(children.data?.map((s) => s.id)).toEqual(["ses_child"])
  })

  it("reports idle from the listing and busy from the active route or executions the stream saw", async () => {
    const a = api()
    // A fresh session has no idle mark: the listing cannot call it busy.
    expect((await a.session.status()).data).toEqual({ ses_root: { type: "idle" }, ses_other: { type: "idle" } })
    server.active = { ses_other: { type: "running" } }
    expect((await a.session.status()).data?.ses_other).toEqual({ type: "busy" })
    server.active = {}
    const controller = new AbortController()
    const iterator = (await a.events(controller.signal))[Symbol.asyncIterator]()
    await iterator.next()
    server.push({ id: "evt_x", created: 1, type: "session.execution.started", data: { sessionID: "ses_child" } })
    await iterator.next()
    expect((await a.session.status()).data?.ses_child).toEqual({ type: "busy" })
    server.push({ id: "evt_y", created: 2, type: "session.idle", data: { sessionID: "ses_child" } })
    await iterator.next()
    expect((await a.session.status()).data?.ses_child).toBeUndefined()
    controller.abort()
  })

  it("loads a session's messages as info and parts, and a missing session as its 404", async () => {
    const res = await api().session.messages("ses_root")
    expect(res.data?.map((m) => m.info.role)).toEqual(["user", "assistant"])
    expect(res.data?.[1]?.parts).toEqual([expect.objectContaining({ type: "text", text: "hello" })])
    const missing = await api().session.messages("ses_nope")
    expect(missing.data).toBeUndefined()
    expect(String((missing.error as Error).message)).toContain("session not found")
  })

  it("fills the catalogs from the 2.0 routes with the location on each request", async () => {
    const a = api()
    const [providers, agents, commands, mcp] = await Promise.all([a.config.providers(), a.app.agents(), a.command.list(), a.mcp.status()])
    expect(providers.data?.providers[0]).toMatchObject({ id: "p", name: "Provider P" })
    expect(Object.keys((providers.data?.providers[0]?.models.m as unknown as { variants: object }).variants)).toEqual(["high"])
    expect(agents.data).toEqual([expect.objectContaining({ name: "build", mode: "primary" })])
    expect(commands.data).toEqual([{ name: "review", description: undefined, template: "" }])
    expect(mcp.data).toEqual({ github: { status: "connected" } })
    for (const path of ["/api/model", "/api/provider", "/api/agent", "/api/command", "/api/mcp"]) {
      expect(server.requests.find((r) => r.path === path)?.query).toEqual({ "location[directory]": "/ws" })
    }
  })

  it("streams events until the signal aborts", async () => {
    const controller = new AbortController()
    const stream = await api().events(controller.signal)
    const iterator = stream[Symbol.asyncIterator]()
    expect(((await iterator.next()).value as { type: string }).type).toBe("server.connected")
    const next = iterator.next()
    server.push({ id: "evt_1", created: 2, type: "session.idle", data: { sessionID: "ses_root" } })
    expect(((await next).value as { type: string }).type).toBe("session.idle")
    controller.abort()
    const ended = await iterator.next().then((r) => r.done === true, () => true)
    expect(ended).toBe(true)
  })

  it("answers a permission and a form through the session-scoped routes it saw asked", async () => {
    const a = api()
    const controller = new AbortController()
    const stream = await a.events(controller.signal)
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    server.push({ id: "evt_p", created: 1, type: "permission.asked", data: { id: "req_1", sessionID: "ses_root", action: "bash", resources: ["ls"] } })
    server.push({ id: "evt_f", created: 2, type: "form.created", data: { form: { id: "form_1", sessionID: "ses_root", title: "Pick", fields: [{ key: "env", type: "string", options: [{ value: "prod", label: "Production" }] }] } } })
    expect(((await iterator.next()).value as { type: string }).type).toBe("permission.asked")
    expect(((await iterator.next()).value as { type: string }).type).toBe("question.asked")

    expect((await a.permission.reply("req_1", "once")).data).toBe(true)
    expect(server.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/session/ses_root/permission/req_1/reply", body: { decision: "once" } })
    expect((await a.question.reply("form_1", [["Production"]])).data).toBe(true)
    expect(server.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/session/ses_root/form/form_1/reply", body: { answer: { env: "prod" } } })
    expect((await a.question.reject("form_1")).data).toBe(true)
    expect(server.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/api/session/ses_root/form/form_1" })

    const unseen = await a.permission.reply("req_other", "reject")
    expect(unseen.status).toBe(404)
    expect(String((unseen.error as Error).message)).toContain("not seen on this connection")
    controller.abort()
  })

  it("creates, renames, stops, and deletes a session on the recorded routes", async () => {
    const a = api()
    const created = await a.session.create()
    expect(created.data).toMatchObject({ id: "ses_4", title: "New session", directory: "/ws" })
    expect(server.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/session", body: { location: { directory: "/ws" } } })
    const renamed = await a.session.update("ses_4", { title: "Renamed" })
    expect(renamed.data?.title).toBe("Renamed")
    expect(server.requests.find((r) => r.method === "PATCH")).toMatchObject({ path: "/api/session/ses_4", body: { title: "Renamed" } })
    expect((await a.session.abort("ses_4")).data).toBe(true)
    expect(server.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/session/ses_4/interrupt" })
    expect((await a.session.delete("ses_4")).data).toBe(true)
    expect(server.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/api/session/ses_4" })
    expect(server.sessions.some((s) => s.id === "ses_4")).toBe(false)
  })

  it("delivers a prompt as model and agent switches, context as an instruction, then text and files", async () => {
    const body = {
      parts: [
        { type: "text", text: "Workspace: /ws\n<README excerpt>", synthetic: true },
        { type: "text", text: "explain the build" },
        { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "shot.png" },
      ],
      model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      agent: "plan",
      variant: "high",
    } as unknown as Parameters<ReturnType<typeof api>["session"]["promptAsync"]>[1]
    const before = server.requests.length
    expect((await api().session.promptAsync("ses_root", body)).error).toBeUndefined()
    expect(server.requests.slice(before).map((r) => [r.method, r.path, r.body])).toEqual([
      ["POST", "/api/session/ses_root/model", { model: { id: "claude-sonnet-5", providerID: "anthropic", variant: "high" } }],
      ["POST", "/api/session/ses_root/agent", { agent: "plan" }],
      ["PUT", "/api/experimental/session/ses_root/instructions/entries/opencui.context", { value: "Workspace: /ws\n<README excerpt>" }],
      ["POST", "/api/session/ses_root/prompt", { text: "explain the build", files: [{ uri: "data:image/png;base64,AAAA", name: "shot.png" }] }],
    ])
    // A prompt without context clears the entry the previous one set.
    const bare = server.requests.length
    await api().session.promptAsync("ses_root", { parts: [{ type: "text", text: "and now?" }] })
    expect(server.requests.slice(bare).map((r) => [r.method, r.path])).toEqual([
      ["POST", "/api/session/ses_root/prompt"],
    ])
  })

  it("waits for a sync prompt's turn and answers with the last assistant message", async () => {
    const res = await api().session.prompt("ses_root", { parts: [{ type: "text", text: "hi" }] })
    expect(server.requests.some((r) => r.path === "/api/experimental/session/ses_root/wait")).toBe(true)
    expect(res.data?.info).toMatchObject({ id: "a1", role: "assistant" })
    expect(res.data?.parts).toEqual([expect.objectContaining({ type: "text", text: "hello" })])
  })

  it("runs the slash commands on the recorded routes", async () => {
    const a = api()
    expect((await a.session.summarize("ses_root")).data).toBe(true)
    expect(server.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/session/ses_root/compact" })
    expect((await a.session.revert("ses_root", { messageID: "u1" })).data?.id).toBe("ses_root")
    expect(server.requests.find((r) => r.path.endsWith("/revert/stage"))).toMatchObject({ method: "POST", body: { messageID: "u1" } })
    expect((await a.session.unrevert("ses_root")).data?.id).toBe("ses_root")
    expect(server.requests.find((r) => r.method === "DELETE" && r.path.endsWith("/revert"))).toMatchObject({ path: "/api/session/ses_root/revert" })
    const forked = await a.session.fork("ses_root", { messageID: "u1" })
    expect(forked.data).toMatchObject({ id: "ses_4", title: "Fork of Root chat" })
    expect(server.requests.find((r) => r.path.endsWith("/fork"))).toMatchObject({ body: { before: "u1" } })
    expect((await a.session.command("ses_root", { command: "review", arguments: "the diff" })).error).toBeUndefined()
    expect(server.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/session/ses_root/command", body: { name: "review", text: "the diff" } })
    expect((await a.session.init("ses_root", { messageID: "msg_1", providerID: "p", modelID: "m" })).data).toBe(true)
    expect(server.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/session/ses_root/command", body: { name: "init", text: "" } })
  })

  it("adds, disconnects, and reconnects an MCP server on the experimental routes", async () => {
    const a = api()
    const added = await a.mcp.add({ name: "linear", config: { type: "remote", url: "https://mcp.linear.app", enabled: true } })
    expect(added.data).toMatchObject({ github: { status: "connected" }, linear: { status: "connected" } })
    expect(server.requests.find((r) => r.method === "PUT")).toMatchObject({ path: "/api/experimental/mcp/linear", query: { "location[directory]": "/ws" }, body: { config: { type: "remote", url: "https://mcp.linear.app", disabled: false } } })
    expect((await a.mcp.disconnect("linear")).data).toBe(true)
    expect(server.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/experimental/mcp/linear/disconnect" })
    expect((await a.mcp.connect("linear")).data).toBe(true)
    expect((await a.mcp.status()).data?.linear).toEqual({ status: "connected" })
  })

  it("signs an MCP server in through its integration's OAuth attempt, then reconnects it", async () => {
    server.mcp = [{ name: "linear", status: { status: "needs_auth", error: "sign in" }, integrationID: "linear-int" }, { name: "local", status: { status: "connected" } }]
    server.integrations = [{ id: "linear-int", name: "Linear", methods: [{ id: "oauth-1", type: "oauth", label: "Sign in" }], connections: [] }]
    const a = api()
    expect((await a.mcp.auth.authorize("linear")).data).toEqual({ url: "https://auth.example/start", method: "auto", instructions: "Finish in the browser" })
    expect(server.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/integration/linear-int/connect/oauth", body: { methodID: "oauth-1" } })
    expect((await a.mcp.auth.callback("linear", {})).data).toEqual({ status: "connected" })
    expect(server.requests.slice(-3).map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/integration/linear-int/connect/oauth/att_1",
      "POST /api/experimental/mcp/linear/connect",
      "GET /api/mcp",
    ])
    expect(String((await a.mcp.auth.authorize("local")).error)).toContain("no sign-in integration")
  })

  it("connects a provider with a key through its integration, lists it as connected, and removes the credential", async () => {
    server.providers = [{ id: "p", name: "Provider P", integrationID: "p-int", activation: "enabled", package: "pkg" }]
    server.integrations = [{ id: "p-int", name: "Provider P", methods: [{ type: "key", label: "API key" }, { id: "oauth-1", type: "oauth", label: "Sign in" }], connections: [] }]
    const a = api()
    expect((await a.provider.list()).data).toMatchObject({ all: [{ id: "p", name: "Provider P" }], connected: [] })
    expect((await a.provider.auth()).data).toEqual({ p: [{ type: "api", label: "API key" }, { type: "oauth", label: "Sign in" }] })
    expect((await a.auth.set("p", { type: "api", key: "sk-1" })).data).toBe(true)
    expect(server.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/integration/p-int/connect/key", body: { key: "sk-1" } })
    expect((await a.provider.list()).data?.connected).toEqual(["p"])
    expect(await a.auth.remove("p")).toEqual({ kind: "ok" })
    expect(server.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/api/credential/cred_1" })
    expect(await a.auth.remove("p")).toMatchObject({ kind: "error" })
    expect(await a.instance.refresh()).toBe(true)
    expect(server.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/location/reload" })
  })

  it("runs an OAuth login as a 2.0 attempt: authorize, then complete by code or by polling", async () => {
    server.providers = [{ id: "p", name: "Provider P", integrationID: "p-int", activation: "enabled", package: "pkg" }]
    server.integrations = [{ id: "p-int", name: "Provider P", methods: [{ type: "key" }, { id: "oauth-1", type: "oauth", label: "Sign in" }], connections: [] }]
    const a = api()
    const authorized = await a.provider.oauth.authorize("p", { method: 1 })
    expect(authorized.data).toEqual({ url: "https://auth.example/start", method: "auto", instructions: "Finish in the browser" })
    expect(server.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/integration/p-int/connect/oauth", body: { methodID: "oauth-1" } })
    expect((await a.provider.oauth.callback("p", { method: 1, code: "abc" })).data).toBe(true)
    expect(server.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/integration/p-int/connect/oauth/att_1/complete", body: { code: "abc" } })
    await a.provider.oauth.authorize("p", { method: 1 })
    expect((await a.provider.oauth.callback("p", { method: 1 })).data).toBe(true)
    expect(server.requests.at(-1)).toMatchObject({ method: "GET", path: "/api/integration/p-int/connect/oauth/att_1" })
    expect(String((await a.provider.oauth.authorize("p", { method: 0 })).error)).toContain("not OAuth")
  })

  it("answers the operations the later steps own with a failure, not a hang", async () => {
    const res = await api().session.share("ses_root")
    expect(res.data).toBeUndefined()
    expect(res.status).toBe(501)
    expect(String((res.error as Error).message)).toContain("not available on opencode 2.0 yet")
  })
})
