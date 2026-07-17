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

describe("subscribeSession watchdog", () => {
  it("fires onSessionIdle when /session/status reports idle after no events", async () => {
    let idleCount = 0
    const backend = makeBackend()
    server.setSessionStatus("ses_test", { type: "idle" })

    const subscription = subscribeSession(
      backend,
      "ses_test",
      {
        onSessionIdle: () => idleCount++,
        onTextDelta: () => {},
      },
      { watchdogMs: 50 },
    )
    await subscription.ready
    await server.awaitClient()

    // Activity sets busyTracked → watchdog arms.
    server.push({
      type: "message.part.updated",
      part: { messageID: "msg_a", sessionID: "ses_test", id: "p1", type: "text", text: "hi" },
    })
    // Allow the SSE chunk to flow before idle.
    await wait(10)
    expect(idleCount).toBe(0)

    // Wait past the watchdog window with no further events.
    await wait(200)
    subscription.abort()
    expect(idleCount).toBe(1)
    expect(server.statusPollCount()).toBeGreaterThanOrEqual(1)
  })

  it("resets on every routed event and does not fire while activity continues", async () => {
    let idleCount = 0
    const backend = makeBackend()
    server.setSessionStatus("ses_test", { type: "idle" })

    const subscription = subscribeSession(
      backend,
      "ses_test",
      {
        onSessionIdle: () => idleCount++,
        onTextDelta: () => {},
      },
      { watchdogMs: 120 },
    )
    await subscription.ready
    await server.awaitClient()

    // Stream events every 40 ms — each one resets the watchdog.
    for (let i = 0; i < 5; i++) {
      server.push({
        type: "message.part.updated",
        part: { messageID: "msg_a", sessionID: "ses_test", id: `p${i}`, type: "text", text: `x${i}` },
      })
      await wait(40)
    }

    subscription.abort()
    // No watchdog should have fired because activity was steady.
    expect(idleCount).toBe(0)
    expect(server.statusPollCount()).toBe(0)
  })

  it("re-arms the watchdog when /session/status reports busy", async () => {
    let idleCount = 0
    const backend = makeBackend()
    server.setSessionStatus("ses_test", { type: "busy" })

    const subscription = subscribeSession(
      backend,
      "ses_test",
      {
        onSessionIdle: () => idleCount++,
        onTextDelta: () => {},
      },
      { watchdogMs: 50 },
    )
    await subscription.ready
    await server.awaitClient()

    server.push({
      type: "message.part.updated",
      part: { messageID: "msg_a", sessionID: "ses_test", id: "p1", type: "text", text: "hi" },
    })

    // First watchdog fire sees busy → should NOT emit idle.
    await wait(150)
    expect(idleCount).toBe(0)
    expect(server.statusPollCount()).toBeGreaterThanOrEqual(1)
    const firstPolls = server.statusPollCount()

    // Server flips to idle → next watchdog tick recovers.
    server.setSessionStatus("ses_test", { type: "idle" })
    await wait(150)
    subscription.abort()
    expect(idleCount).toBe(1)
    expect(server.statusPollCount()).toBeGreaterThan(firstPolls)
  })

  it("does not arm the watchdog before any activity", async () => {
    let idleCount = 0
    const backend = makeBackend()
    server.setSessionStatus("ses_test", { type: "idle" })

    const subscription = subscribeSession(
      backend,
      "ses_test",
      {
        onSessionIdle: () => idleCount++,
        onTextDelta: () => {},
      },
      { watchdogMs: 50 },
    )
    await subscription.ready
    await server.awaitClient()

    await wait(150)
    subscription.abort()
    expect(idleCount).toBe(0)
    expect(server.statusPollCount()).toBe(0)
  })

  it("stops the watchdog after abort", async () => {
    const backend = makeBackend()
    server.setSessionStatus("ses_test", { type: "idle" })

    const subscription = subscribeSession(
      backend,
      "ses_test",
      {
        onSessionIdle: () => {},
        onTextDelta: () => {},
      },
      { watchdogMs: 50 },
    )
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "message.part.updated",
      part: { messageID: "msg_a", sessionID: "ses_test", id: "p1", type: "text", text: "hi" },
    })
    subscription.abort()

    const baseline = server.statusPollCount()
    await wait(150)
    // Watchdog should have been cancelled by abort, no further polls.
    expect(server.statusPollCount()).toBe(baseline)
  })

  it("session.idle event clears the watchdog (no poll)", async () => {
    let idleCount = 0
    const backend = makeBackend()
    server.setSessionStatus("ses_test", { type: "idle" })

    const subscription = subscribeSession(
      backend,
      "ses_test",
      {
        onSessionIdle: () => idleCount++,
        onTextDelta: () => {},
      },
      { watchdogMs: 50 },
    )
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "message.part.updated",
      part: { messageID: "msg_a", sessionID: "ses_test", id: "p1", type: "text", text: "hi" },
    })
    await wait(10)
    server.push({ type: "session.idle", sessionID: "ses_test" })
    await wait(150)
    subscription.abort()
    expect(idleCount).toBe(1)
    expect(server.statusPollCount()).toBe(0)
  })
})

describe("subscribeSession terminal-finish gating", () => {
  it("defers assistantEnd while a tool part is still running, fires when it completes", async () => {
    const ends: Array<{ mid: string; finish?: string }> = []
    const backend = makeBackend()
    server.setSessionStatus("ses_test", { type: "idle" })

    const subscription = subscribeSession(
      backend,
      "ses_test",
      {
        onAssistantEnd: (mid, payload) => ends.push({ mid, finish: payload.finish }),
        onTextDelta: () => {},
        onTool: () => {},
      },
      // Large watchdog — we don't want it to interfere here.
      { watchdogMs: 10_000 },
    )
    await subscription.ready
    await server.awaitClient()

    // A running tool part for msg_a.
    server.push({
      type: "message.part.updated",
      part: {
        messageID: "msg_a",
        sessionID: "ses_test",
        id: "tp1",
        callID: "call_1",
        tool: "bash",
        type: "tool",
        state: { status: "running" },
      },
    })
    await wait(10)

    // Provider returns finish: "stop" while the tool is still running.
    server.push({
      type: "message.updated",
      info: { id: "msg_a", role: "assistant", sessionID: "ses_test", finish: "stop" },
    })
    await wait(20)
    expect(ends).toHaveLength(0)

    // Tool part terminates → deferred assistantEnd fires.
    server.push({
      type: "message.part.updated",
      part: {
        messageID: "msg_a",
        sessionID: "ses_test",
        id: "tp1",
        callID: "call_1",
        tool: "bash",
        type: "tool",
        state: { status: "completed" },
      },
    })
    await wait(20)
    subscription.abort()

    expect(ends).toHaveLength(1)
    expect(ends[0]).toEqual({ mid: "msg_a", finish: "stop" })
  })

  it("emits assistantEnd immediately when finish arrives with no active tool parts", async () => {
    const ends: Array<{ mid: string }> = []
    const backend = makeBackend()
    server.setSessionStatus("ses_test", { type: "idle" })

    const subscription = subscribeSession(
      backend,
      "ses_test",
      {
        onAssistantEnd: (mid) => ends.push({ mid }),
        onTextDelta: () => {},
      },
      { watchdogMs: 10_000 },
    )
    await subscription.ready
    await server.awaitClient()

    server.push({
      type: "message.updated",
      info: { id: "msg_b", role: "assistant", sessionID: "ses_test", finish: "stop" },
    })
    await wait(20)
    subscription.abort()
    expect(ends).toEqual([{ mid: "msg_b" }])
  })

  it("does not fire assistantEnd for finish: tool-calls (existing behaviour)", async () => {
    const ends: Array<{ mid: string }> = []
    const backend = makeBackend()
    server.setSessionStatus("ses_test", { type: "idle" })

    const subscription = subscribeSession(
      backend,
      "ses_test",
      {
        onAssistantEnd: (mid) => ends.push({ mid }),
        onTextDelta: () => {},
      },
      { watchdogMs: 10_000 },
    )
    await subscription.ready
    await server.awaitClient()

    server.push({
      type: "message.updated",
      info: { id: "msg_c", role: "assistant", sessionID: "ses_test", finish: "tool-calls" },
    })
    await wait(20)
    subscription.abort()
    expect(ends).toHaveLength(0)
  })
})

describe("subscribeSession watchdog: post-idle bookkeeping and stale polls", () => {
  it("post-idle bookkeeping events do not re-arm the watchdog", async () => {
    let idleCount = 0
    const backend = makeBackend()
    server.setSessionStatus("ses_test", { type: "idle" })

    const subscription = subscribeSession(
      backend,
      "ses_test",
      { onSessionIdle: () => idleCount++, onTextDelta: () => {} },
      { watchdogMs: 50 },
    )
    await subscription.ready
    await server.awaitClient()

    server.push({
      type: "message.part.updated",
      part: { messageID: "msg_a", sessionID: "ses_test", id: "p1", type: "text", text: "hi" },
    })
    await wait(10)
    server.push({ type: "session.idle", sessionID: "ses_test" })
    await wait(20)
    expect(idleCount).toBe(1)

    // The trailing bookkeeping opencode sends AFTER idle (observed live):
    // an update for the finished assistant message, a user-row rewrite,
    // and a revert-style removal. None of these mean live work.
    server.push({
      type: "message.updated",
      info: { id: "msg_a", role: "assistant", sessionID: "ses_test", finish: "stop" },
    })
    server.push({ type: "message.updated", info: { id: "usr_1", role: "user", sessionID: "ses_test" } })
    server.push({ type: "message.removed", sessionID: "ses_test", messageID: "msg_gone" })

    // Several watchdog windows of silence: no poll, no duplicate idle.
    await wait(220)
    subscription.abort()
    expect(idleCount).toBe(1)
    expect(server.statusPollCount()).toBe(0)
  })

  it("an in-flight assistant message.updated still arms the watchdog", async () => {
    let idleCount = 0
    const backend = makeBackend()
    server.setSessionStatus("ses_test", { type: "idle" })

    const subscription = subscribeSession(
      backend,
      "ses_test",
      { onSessionIdle: () => idleCount++, onTextDelta: () => {} },
      { watchdogMs: 50 },
    )
    await subscription.ready
    await server.awaitClient()

    // A stream that dies right after the assistant message appears (no
    // parts yet, no finish) must still be recoverable.
    server.push({
      type: "message.updated",
      info: { id: "msg_a", role: "assistant", sessionID: "ses_test" },
    })
    await wait(200)
    subscription.abort()
    expect(idleCount).toBe(1)
    expect(server.statusPollCount()).toBeGreaterThanOrEqual(1)
  })

  it("a new turn's part events resume watchdog tracking after idle", async () => {
    let idleCount = 0
    const backend = makeBackend()
    server.setSessionStatus("ses_test", { type: "idle" })

    const subscription = subscribeSession(
      backend,
      "ses_test",
      { onSessionIdle: () => idleCount++, onTextDelta: () => {} },
      { watchdogMs: 50 },
    )
    await subscription.ready
    await server.awaitClient()

    server.push({
      type: "message.part.updated",
      part: { messageID: "msg_a", sessionID: "ses_test", id: "p1", type: "text", text: "hi" },
    })
    await wait(10)
    server.push({ type: "session.idle", sessionID: "ses_test" })
    await wait(20)
    expect(idleCount).toBe(1)

    // Next turn streams, then the connection goes quiet — recovery must
    // still work after an idle latch.
    server.push({
      type: "message.part.updated",
      part: { messageID: "msg_b", sessionID: "ses_test", id: "p2", type: "text", text: "again" },
    })
    await wait(200)
    subscription.abort()
    expect(idleCount).toBe(2)
    expect(server.statusPollCount()).toBeGreaterThanOrEqual(1)
  })

  it("discards a stale status poll answered after new activity", async () => {
    let idleCount = 0
    const backend = makeBackend()
    server.setSessionStatus("ses_test", { type: "idle" })
    server.setStatusDelay(120)

    const subscription = subscribeSession(
      backend,
      "ses_test",
      { onSessionIdle: () => idleCount++, onTextDelta: () => {} },
      { watchdogMs: 50 },
    )
    await subscription.ready
    await server.awaitClient()

    server.push({
      type: "message.part.updated",
      part: { messageID: "msg_a", sessionID: "ses_test", id: "p1", type: "text", text: "hi" },
    })
    // Let the watchdog fire; its poll is now in flight (delayed 120 ms).
    await wait(70)
    expect(server.statusPollCount()).toBeGreaterThanOrEqual(1)

    // A new turn's events arrive while the poll is airborne. Keep the
    // stream visibly alive past the poll's resolution — the stale "idle"
    // answer must be discarded, not emitted into the running turn.
    for (let i = 0; i < 8; i++) {
      server.push({
        type: "message.part.updated",
        part: { messageID: "msg_b", sessionID: "ses_test", id: `q${i}`, type: "text", text: `x${i}` },
      })
      await wait(30)
    }
    subscription.abort()
    expect(idleCount).toBe(0)
  })
})
