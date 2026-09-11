import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { startMockOpencode, type MockOpencodeServer } from "./mock-opencode-server"
import { subscribeSession } from "../../src/chat/stream"
import type { SessionRetryInfo } from "../../src/protocol"

let server: MockOpencodeServer

beforeEach(async () => {
  server = await startMockOpencode()
})

afterEach(async () => {
  await server.close()
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function subscribe() {
  const client = createOpencodeClient({ baseUrl: server.url })
  const backend = { url: server.url, client, directory: "/tmp" } as any
  const retries: Array<SessionRetryInfo | undefined> = []
  let busy = 0
  let idle = 0
  const subscription = subscribeSession(
    backend,
    "ses_test",
    {
      onTextDelta: () => {},
      onSessionBusy: () => busy++,
      onSessionIdle: () => idle++,
      onSessionRetry: (r) => retries.push(r),
    },
    { watchdogMs: 10_000 },
  )
  await subscription.ready
  await server.awaitClient()
  return { subscription, retries, busy: () => busy, idle: () => idle }
}

const retryStatus = (over: Record<string, unknown> = {}, sessionID = "ses_test") => ({
  type: "session.status",
  sessionID,
  status: { type: "retry", attempt: 2, message: "Provider is overloaded", next: 1_800_000_000_000, ...over },
})

describe("subscribeSession retry status (#611)", () => {
  it("reports a retry with its details and counts it as busy", async () => {
    const s = await subscribe()
    server.push(retryStatus())
    await wait(30)
    s.subscription.abort()
    expect(s.busy()).toBe(1)
    expect(s.retries).toEqual([
      { attempt: 2, message: "Provider is overloaded", next: 1_800_000_000_000, action: undefined },
    ])
  })

  it("passes an account-limit action through with only the fields the bubble shows", async () => {
    const s = await subscribe()
    server.push(
      retryStatus({
        action: {
          reason: "account_rate_limit",
          provider: "opencode",
          title: "Go limit reached",
          message: "Usage limit reached.",
          label: "open settings",
          link: "https://opencode.ai/workspace/w/go",
        },
      }),
    )
    await wait(30)
    s.subscription.abort()
    expect(s.retries[0]?.action).toEqual({
      title: "Go limit reached",
      message: "Usage limit reached.",
      label: "open settings",
      link: "https://opencode.ai/workspace/w/go",
    })
  })

  it("clears the retry once the session shows progress", async () => {
    const s = await subscribe()
    server.push(retryStatus())
    await wait(30)
    server.push({
      type: "message.part.delta",
      sessionID: "ses_test",
      messageID: "msg_a",
      partID: "p1",
      field: "text",
      delta: "hi",
    })
    await wait(30)
    s.subscription.abort()
    expect(s.retries.map((r) => r?.attempt)).toEqual([2, undefined])
  })

  it("clears the retry on a plain busy status and on idle", async () => {
    const s = await subscribe()
    server.push(retryStatus())
    await wait(30)
    server.push({ type: "session.status", sessionID: "ses_test", status: { type: "busy" } })
    await wait(30)
    server.push(retryStatus({ attempt: 3 }))
    await wait(30)
    server.push({ type: "session.idle", sessionID: "ses_test" })
    await wait(30)
    s.subscription.abort()
    expect(s.retries.map((r) => r?.attempt)).toEqual([2, undefined, 3, undefined])
    expect(s.idle()).toBe(1)
  })

  it("ignores a retry for another session", async () => {
    const s = await subscribe()
    server.push(retryStatus({}, "ses_other"))
    await wait(30)
    s.subscription.abort()
    expect(s.retries).toEqual([])
    expect(s.busy()).toBe(0)
  })
})
