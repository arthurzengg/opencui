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

// opencode publishes a reasoning part's deltas with `field: "text"` (the
// property name on the ReasoningPart), so the delta alone cannot say whether
// it is thinking or answer. The part's type is known from the
// `message.part.updated` opencode sends when it creates the part, before the
// first delta (#591).
describe("subscribeSession routes part deltas by the announced part type", () => {
  const part = (id: string, type: "text" | "reasoning", text: string) => ({
    type: "message.part.updated",
    part: { id, messageID: "msg_a", sessionID: "ses_test", type, text },
  })
  const delta = (partID: string, delta: string) => ({
    type: "message.part.delta",
    sessionID: "ses_test",
    messageID: "msg_a",
    partID,
    field: "text",
    delta,
  })

  async function subscribe() {
    const text: string[] = []
    const reasoning: string[] = []
    const subscription = subscribeSession(
      makeBackend(),
      "ses_test",
      {
        onTextDelta: (_id, d) => text.push(d),
        onReasoningDelta: (_id, d) => reasoning.push(d),
      },
      { watchdogMs: 10_000 },
    )
    await subscription.ready
    await server.awaitClient()
    return { subscription, text, reasoning }
  }

  it("a reasoning part's deltas reach onReasoningDelta and the text part's reach onTextDelta", async () => {
    const { subscription, text, reasoning } = await subscribe()

    server.push(part("p_think", "reasoning", ""))
    server.push(delta("p_think", "Let me "))
    server.push(delta("p_think", "think."))
    // reasoning-end: the full-text snapshot must not re-emit what streamed.
    server.push(part("p_think", "reasoning", "Let me think."))
    server.push(part("p_text", "text", ""))
    server.push(delta("p_text", "Hello"))
    server.push(part("p_text", "text", "Hello"))
    await wait(30)
    subscription.abort()

    expect(reasoning).toEqual(["Let me ", "think."])
    expect(text).toEqual(["Hello"])
  })

  it("a delta for a part this subscription never saw announced is treated as answer text", async () => {
    const { subscription, text, reasoning } = await subscribe()

    server.push(delta("p_unknown", "tail"))
    await wait(30)
    subscription.abort()

    expect(text).toEqual(["tail"])
    expect(reasoning).toEqual([])
  })
})
