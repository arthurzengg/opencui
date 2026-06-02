import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { startMockOpencode, type MockOpencodeServer } from "./mock-opencode-server"
import { subscribeSession } from "../../src/chat/stream"

let server: MockOpencodeServer

beforeEach(async () => {
  server = await startMockOpencode()
})

afterEach(async () => {
  await server.close()
})

function makeBackend() {
  const client = createOpencodeClient({ baseUrl: server.url })
  return { url: server.url, client, directory: "/tmp" }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("subscribeSession message.part.delta guard", () => {
  it("a malformed delta (missing/non-string `delta`) does not throw or tear down the subscription", async () => {
    const textDeltas: string[] = []
    let sessionErrors = 0
    const backend = makeBackend()

    const subscription = subscribeSession(
      backend,
      "ses_test",
      {
        onTextDelta: (_id, delta) => textDeltas.push(delta),
        onSessionError: () => sessionErrors++,
      },
      // Long watchdog so it can't interfere with the assertions.
      { watchdogMs: 10_000 },
    )
    await subscription.ready
    await server.awaitClient()

    // field=text but no `delta`: before the guard this threw on `p.delta.length`,
    // propagated out of the SSE reader loop, and killed the live subscription.
    server.push({
      type: "message.part.delta",
      sessionID: "ses_test",
      messageID: "msg_a",
      partID: "p1",
      field: "text",
    })
    await wait(20)

    // A subsequent VALID delta must still be delivered — proves the stream survived.
    server.push({
      type: "message.part.delta",
      sessionID: "ses_test",
      messageID: "msg_a",
      partID: "p1",
      field: "text",
      delta: "hello",
    })
    await wait(20)

    subscription.abort()
    expect(sessionErrors).toBe(0)
    expect(textDeltas).toEqual(["hello"])
  })
})
