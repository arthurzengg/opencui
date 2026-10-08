import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { createOpencodeClient as createOpencodeClientV2 } from "@opencode-ai/sdk/v2"
import { startMockOpencode, type MockOpencodeServer } from "./mock-opencode-server"
import { createV1Api } from "../../src/backend/v1"

let server: MockOpencodeServer

beforeEach(async () => {
  server = await startMockOpencode()
})
afterEach(async () => {
  await server.close()
})

function api(directory = "/ws") {
  return createV1Api(
    createOpencodeClient({ baseUrl: server.url, directory }),
    createOpencodeClientV2({ baseUrl: server.url, directory }),
    directory,
  )
}

describe("opencode 1.x adapter (#689)", () => {
  it("answers with the data and the HTTP status", async () => {
    const res = await api().session.create()
    expect(res.error).toBeUndefined()
    expect(res.data?.id).toBe("ses_test")
    expect(res.status).toBe(200)
  })

  // Callers tell a session the server no longer has (404) apart from a failure.
  it("answers a missing session with its 404", async () => {
    const res = await api().session.delete("ses_missing")
    expect(res.data).toBeUndefined()
    expect(res.status).toBe(404)
  })

  it("loads the catalogs the pickers read", async () => {
    const a = api()
    const [agents, providers, commands] = await Promise.all([a.app.agents(), a.config.providers(), a.command.list()])
    expect(Array.isArray(agents.data)).toBe(true)
    expect(providers.data?.providers).toBeDefined()
    expect(Array.isArray(commands.data)).toBe(true)
  })

  it("sends the bound directory with replies and passes list filters through", async () => {
    const a = api("/bound")
    const listed = await a.session.list({ roots: true, limit: 5 })
    expect(Array.isArray(listed.data)).toBe(true)
    const replied = await a.permission.reply("req_1", "once")
    expect(replied.error).toBeUndefined()
    expect(server.permissionReplies).toEqual([expect.objectContaining({ requestID: "req_1", directory: "/bound" })])
  })

  it("streams every event until the signal aborts", async () => {
    const controller = new AbortController()
    const stream = await api().events(controller.signal)
    const iterator = stream[Symbol.asyncIterator]()
    const first = iterator.next()
    await server.awaitClient()
    server.push({ type: "session.idle", sessionID: "ses_test" })
    expect((await first).value).toMatchObject({ type: "session.idle", properties: { sessionID: "ses_test" } })
    controller.abort()
    expect((await iterator.next()).done).toBe(true)
  })

  it("reports the status of a health route the server lacks", async () => {
    const res = await api().health()
    expect(res.data).toBeUndefined()
    expect(res.status).toBe(404)
  })
})
