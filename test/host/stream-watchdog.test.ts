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
      { watchdogMs: 30 },
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
    await wait(120)
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
      { watchdogMs: 60 },
    )
    await subscription.ready
    await server.awaitClient()

    // Stream events every 25 ms — each one resets the watchdog.
    for (let i = 0; i < 5; i++) {
      server.push({
        type: "message.part.updated",
        part: { messageID: "msg_a", sessionID: "ses_test", id: `p${i}`, type: "text", text: `x${i}` },
      })
      await wait(25)
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
      { watchdogMs: 30 },
    )
    await subscription.ready
    await server.awaitClient()

    server.push({
      type: "message.part.updated",
      part: { messageID: "msg_a", sessionID: "ses_test", id: "p1", type: "text", text: "hi" },
    })

    // First watchdog fire sees busy → should NOT emit idle.
    await wait(60)
    expect(idleCount).toBe(0)
    expect(server.statusPollCount()).toBeGreaterThanOrEqual(1)
    const firstPolls = server.statusPollCount()

    // Server flips to idle → next watchdog tick recovers.
    server.setSessionStatus("ses_test", { type: "idle" })
    await wait(60)
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
      { watchdogMs: 30 },
    )
    await subscription.ready
    await server.awaitClient()

    await wait(80)
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
      { watchdogMs: 20 },
    )
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "message.part.updated",
      part: { messageID: "msg_a", sessionID: "ses_test", id: "p1", type: "text", text: "hi" },
    })
    subscription.abort()

    const baseline = server.statusPollCount()
    await wait(80)
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
      { watchdogMs: 30 },
    )
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "message.part.updated",
      part: { messageID: "msg_a", sessionID: "ses_test", id: "p1", type: "text", text: "hi" },
    })
    await wait(5)
    server.push({ type: "session.idle", sessionID: "ses_test" })
    await wait(60)
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
