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

describe("subscribeSession compaction summary flag", () => {
  it("fires onAssistantSummary once per flagged message, after onAssistantStart", async () => {
    const calls: string[] = []
    const subscription = subscribeSession(
      makeBackend(),
      "ses_test",
      {
        onAssistantStart: (mid) => calls.push("start:" + mid),
        onAssistantSummary: (mid) => calls.push("summary:" + mid),
        onTextDelta: () => {},
      },
      { watchdogMs: 10_000 },
    )
    await subscription.ready
    await server.awaitClient()

    // A normal assistant message never fires the summary handler; the
    // compaction message fires it exactly once across repeated updates.
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: "ses_test" } })
    server.push({ type: "message.updated", info: { id: "msg_s", role: "assistant", sessionID: "ses_test", summary: true } })
    server.push({ type: "message.updated", info: { id: "msg_s", role: "assistant", sessionID: "ses_test", summary: true } })
    await wait(30)

    expect(calls).toEqual(["start:msg_a", "start:msg_s", "summary:msg_s"])

    // The flag is honored even when it only appears on a later update of an
    // already-started message.
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: "ses_test", summary: true } })
    await wait(30)

    subscription.abort()
    expect(calls).toEqual(["start:msg_a", "start:msg_s", "summary:msg_s", "summary:msg_a"])
  })
})
