import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { startMockOpencode, type MockOpencodeServer } from "./mock-opencode-server"
import { createSessionStreamState, subscribeSession, type StreamHandlers } from "../../src/chat/stream"

// A re-subscription after stream loss must continue the dead subscription's
// dedup/offset bookkeeping. opencode's events are full snapshots delivered
// at-least-once (the end-of-part `message.part.updated` carries the whole
// text), so a subscription that starts from empty state re-announces the
// in-flight message and re-emits everything already shown (#585).

let server: MockOpencodeServer

beforeEach(async () => {
  server = await startMockOpencode()
})

afterEach(async () => {
  await server.close()
})

const SESSION = "ses_test"
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function backend() {
  const client = createOpencodeClient({ baseUrl: server.url })
  return { url: server.url, client, directory: "/tmp" }
}

type Log = { starts: string[]; deltas: string[]; ends: string[] }

function recorder(): { log: Log; handlers: StreamHandlers } {
  const log: Log = { starts: [], deltas: [], ends: [] }
  return {
    log,
    handlers: {
      onAssistantStart: (mid) => log.starts.push(mid),
      onTextDelta: (_mid, delta) => log.deltas.push(delta),
      onAssistantEnd: (mid) => log.ends.push(mid),
    },
  }
}

async function subscribe(handlers: StreamHandlers, state?: ReturnType<typeof createSessionStreamState>) {
  const subscription = subscribeSession(backend(), SESSION, handlers, { watchdogMs: 10_000, state })
  await subscription.ready
  await server.awaitClient()
  return subscription
}

function textPart(text: string) {
  return {
    type: "message.part.updated",
    part: { id: "part_1", messageID: "msg_a", sessionID: SESSION, type: "text", text },
  }
}

describe("subscribeSession re-attach with shared SessionStreamState", () => {
  it("resumes at the dead stream's offsets: no second assistantStart, only the unseen tail of a re-delivered part", async () => {
    const state = createSessionStreamState(SESSION)
    const { log, handlers } = recorder()

    await subscribe(handlers, state)
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION } })
    server.push(textPart("Hi"))
    await wait(30)
    expect(log.starts).toEqual(["msg_a"])
    expect(log.deltas).toEqual(["Hi"])

    // Transport drop, then the owner re-subscribes with the same state.
    server.dropClients()
    await wait(30)
    const second = await subscribe(handlers, state)
    server.push(textPart("Hi there"))
    server.push({
      type: "message.part.delta",
      sessionID: SESSION,
      messageID: "msg_a",
      partID: "part_1",
      field: "text",
      delta: "!",
    })
    await wait(30)
    second.abort()

    expect(log.starts).toEqual(["msg_a"])
    expect(log.deltas).toEqual(["Hi", " there", "!"])
  })

  it("without shared state the re-subscription re-announces the message and re-emits its full text", async () => {
    // Pins WHY the state is caller-owned: this is the pre-#585 behavior a
    // fresh subscription still exhibits by construction.
    const { log, handlers } = recorder()
    await subscribe(handlers)
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION } })
    server.push(textPart("Hi"))
    await wait(30)
    server.dropClients()
    await wait(30)
    const second = await subscribe(handlers)
    server.push(textPart("Hi there"))
    await wait(30)
    second.abort()

    expect(log.starts).toEqual(["msg_a", "msg_a"])
    expect(log.deltas).toEqual(["Hi", "Hi there"])
  })

  it("a tool that started before the drop still defers assistantEnd after the re-attach", async () => {
    const state = createSessionStreamState(SESSION)
    const { log, handlers } = recorder()

    await subscribe(handlers, state)
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION } })
    server.push({
      type: "message.part.updated",
      part: {
        id: "part_t", messageID: "msg_a", sessionID: SESSION, type: "tool",
        callID: "call_1", tool: "bash", state: { status: "running" },
      },
    })
    await wait(30)
    server.dropClients()
    await wait(30)

    const second = await subscribe(handlers, state)
    // finish=stop while the tool part is still running: with fresh state the
    // running part would be unknown and assistantEnd would fire here.
    server.push({ type: "message.updated", info: { id: "msg_a", role: "assistant", sessionID: SESSION, finish: "stop" } })
    await wait(30)
    expect(log.ends).toEqual([])

    server.push({
      type: "message.part.updated",
      part: {
        id: "part_t", messageID: "msg_a", sessionID: SESSION, type: "tool",
        callID: "call_1", tool: "bash", state: { status: "completed", output: "ok" },
      },
    })
    await wait(30)
    second.abort()
    expect(log.ends).toEqual(["msg_a"])
  })
})

describe("subscribeSession re-attach keeps the part-type map", () => {
  it("deltas of a reasoning part that began before the drop still route as reasoning", async () => {
    const state = createSessionStreamState(SESSION)
    const text: string[] = []
    const reasoning: string[] = []
    const handlers: StreamHandlers = {
      onTextDelta: (_mid, d) => text.push(d),
      onReasoningDelta: (_mid, d) => reasoning.push(d),
    }
    const think = (body: string) => ({
      type: "message.part.updated",
      part: { id: "part_r", messageID: "msg_a", sessionID: SESSION, type: "reasoning", text: body },
    })
    const delta = (d: string) => ({
      type: "message.part.delta",
      sessionID: SESSION,
      messageID: "msg_a",
      partID: "part_r",
      field: "text",
      delta: d,
    })

    await subscribe(handlers, state)
    server.push(think(""))
    server.push(delta("Let me "))
    await wait(30)

    server.dropClients()
    await wait(30)
    const second = await subscribe(handlers, state)
    server.push(delta("think."))
    server.push(think("Let me think."))
    await wait(30)
    second.abort()

    expect(reasoning).toEqual(["Let me ", "think."])
    expect(text).toEqual([])
  })
})
