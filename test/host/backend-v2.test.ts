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

  it("derives session status from idle marks and outcomes", async () => {
    const res = await api().session.status()
    expect(res.data).toEqual({ ses_root: { type: "idle" }, ses_child: { type: "busy" }, ses_other: { type: "idle" } })
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

  it("answers the operations the later steps own with a failure, not a hang", async () => {
    const res = await api().session.create()
    expect(res.data).toBeUndefined()
    expect(res.status).toBe(501)
    expect(String((res.error as Error).message)).toContain("not available on opencode 2.0 yet")
  })
})
