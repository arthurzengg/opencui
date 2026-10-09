import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { OpenCodeEvent } from "@opencode/client/promise"
import { createV2Api } from "../../src/backend/v2/api"
import { subscribeSession, type ToolUpdate } from "../../src/chat/stream"
import type { Backend } from "../../src/server"
import { startMockOpencodeV2, type MockOpencodeV2 } from "./mock-opencode-v2-server"

let server: MockOpencodeV2
beforeEach(async () => {
  server = await startMockOpencodeV2()
})
afterEach(async () => {
  await server.close()
})

let seq = 0
function push<T extends OpenCodeEvent["type"]>(type: T, data: Extract<OpenCodeEvent, { type: T }>["data"]) {
  server.push({ id: `evt_${++seq}`, created: 1000 + seq, type, data })
}

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time")
    await new Promise((r) => setTimeout(r, 15))
  }
}

const S = "ses_1"
const M = "msg_a1"

describe("subscribeSession over opencode 2.0 (#684)", () => {
  it("streams a 2.0 turn through the unchanged router: start, reasoning, text, tool, patch, end, idle", async () => {
    const backend = { url: server.url, api: createV2Api({ url: server.url, directory: "/ws", password: server.password }), directory: "/ws" } as Backend
    const seen = { starts: [] as string[], text: "", reasoning: "", tools: [] as ToolUpdate[], patches: [] as string[][], ends: [] as unknown[], idle: 0, busy: 0 }
    const subscription = subscribeSession(
      backend,
      S,
      {
        onAssistantStart: (id) => seen.starts.push(id),
        onTextDelta: (_id, delta) => (seen.text += delta),
        onReasoningDelta: (_id, delta) => (seen.reasoning += delta),
        onTool: (_id, update) => seen.tools.push(update),
        onPatch: (_id, files) => seen.patches.push(files),
        onAssistantEnd: (_id, payload) => seen.ends.push(payload),
        onSessionIdle: () => seen.idle++,
        onSessionBusy: () => seen.busy++,
      },
      { watchdogMs: 10_000 },
    )
    await subscription.ready
    await server.awaitClient()

    const model = { id: "claude-sonnet-5", providerID: "anthropic" }
    push("session.execution.started", { sessionID: S })
    push("session.step.started", { sessionID: S, assistantMessageID: M, agent: "build", model, started: 1 })
    push("session.reasoning.started", { sessionID: S, assistantMessageID: M, ordinal: 0 })
    push("session.reasoning.delta", { sessionID: S, assistantMessageID: M, ordinal: 0, delta: "think" })
    push("session.reasoning.ended", { sessionID: S, assistantMessageID: M, ordinal: 0, text: "think" })
    push("session.tool.input.started", { sessionID: S, assistantMessageID: M, id: "call_1", name: "read" })
    push("session.tool.called", { sessionID: S, assistantMessageID: M, id: "call_1", input: { filePath: "a.ts" }, executed: true })
    push("session.tool.success", { sessionID: S, assistantMessageID: M, id: "call_1", content: [{ type: "text", text: "ok" }], executed: true })
    push("session.text.started", { sessionID: S, assistantMessageID: M, ordinal: 1 })
    push("session.text.delta", { sessionID: S, assistantMessageID: M, ordinal: 1, delta: "Hello " })
    push("session.text.delta", { sessionID: S, assistantMessageID: M, ordinal: 1, delta: "world" })
    push("session.text.ended", { sessionID: S, assistantMessageID: M, ordinal: 1, text: "Hello world" })
    push("session.step.ended", { sessionID: S, assistantMessageID: M, finish: "stop", cost: 0.25, tokens: { input: 5, output: 7, reasoning: 1, cache: { read: 0, write: 0 } }, files: ["src/a.ts"] })
    push("session.idle", { sessionID: S })

    await until(() => seen.ends.length === 1 && seen.idle === 1)
    expect(seen.starts).toEqual([M])
    expect(seen.reasoning).toBe("think")
    expect(seen.text).toBe("Hello world")
    expect(seen.tools.map((t) => t.status)).toEqual(["running", "completed"])
    expect(seen.tools[1]).toMatchObject({ callID: "call_1", tool: "read", output: "ok", input: { filePath: "a.ts" } })
    expect(seen.patches).toEqual([["src/a.ts"]])
    expect(seen.ends[0]).toMatchObject({ finish: "stop" })
    expect(seen.busy).toBeGreaterThan(0)
    subscription.abort()
  })

  it("marks the turn stopped when 2.0 interrupts it, and errored when the provider fails", async () => {
    const backend = { url: server.url, api: createV2Api({ url: server.url, directory: "/ws", password: server.password }), directory: "/ws" } as Backend
    const ends: Array<{ error?: string }> = []
    const errors: string[] = []
    const subscription = subscribeSession(backend, S, { onTextDelta: () => {}, onAssistantEnd: (_id, p) => ends.push(p), onSessionError: (m) => errors.push(m) }, { watchdogMs: 10_000 })
    await subscription.ready
    await server.awaitClient()
    push("session.step.started", { sessionID: S, assistantMessageID: M, agent: "build", model: { id: "m", providerID: "p" }, started: 1 })
    push("session.execution.interrupted", { sessionID: S, reason: "user" })
    await until(() => ends.length === 1)
    expect(ends[0]!.error).toBe("Aborted")
    push("session.execution.failed", { sessionID: S, error: { type: "ProviderError", message: "rate limited" } })
    await until(() => errors.length === 1)
    expect(errors[0]).toBe("rate limited")
    subscription.abort()
  })

  it("routes a 2.0 permission ask and a form to the permission and question handlers", async () => {
    const backend = { url: server.url, api: createV2Api({ url: server.url, directory: "/ws", password: server.password }), directory: "/ws" } as Backend
    const permissions: Array<{ id: string; title: string; patterns?: string[] }> = []
    const resolved: string[] = []
    const questions: Array<{ id: string; questions: unknown[] }> = []
    const subscription = subscribeSession(
      backend,
      S,
      {
        onTextDelta: () => {},
        onPermissionNeeded: (p) => permissions.push(p),
        onPermissionResolved: (id) => resolved.push(id),
        onQuestionAsked: (q) => questions.push(q),
        onQuestionResolved: (id) => resolved.push(id),
      },
      { watchdogMs: 10_000 },
    )
    await subscription.ready
    await server.awaitClient()
    push("permission.asked", { id: "req_1", sessionID: S, action: "bash", resources: ["git push"], message: "Push to origin?" })
    push("form.created", { form: { id: "form_1", sessionID: S, title: "Branch", fields: [{ key: "name", type: "string", title: "Branch name" }] } })
    await until(() => permissions.length === 1 && questions.length === 1)
    expect(permissions[0]).toMatchObject({ id: "req_1", title: "Push to origin?", patterns: ["git push"] })
    expect(questions[0]).toMatchObject({ id: "form_1", questions: [expect.objectContaining({ header: "Branch name", custom: true })] })
    push("permission.replied", { sessionID: S, requestID: "req_1", reply: "once" })
    push("form.replied", { id: "form_1", sessionID: S, answer: { name: "main" } })
    await until(() => resolved.length === 2)
    expect(resolved).toEqual(["req_1", "form_1"])
    subscription.abort()
  })

  // The watchdog polls session.status when events stop; 2.0 has no status
  // route, so the adapter derives it from the session listing.
  it("recovers a lost idle through the derived status when events stop", async () => {
    server.sessions = [{ id: S, projectID: "p", title: "t", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 10, idle: 10 } }]
    const backend = { url: server.url, api: createV2Api({ url: server.url, directory: "/ws", password: server.password }), directory: "/ws" } as Backend
    let idle = 0
    const subscription = subscribeSession(backend, S, { onTextDelta: () => {}, onSessionIdle: () => idle++ }, { watchdogMs: 50 })
    await subscription.ready
    await server.awaitClient()
    push("session.step.started", { sessionID: S, assistantMessageID: M, agent: "build", model: { id: "m", providerID: "p" }, started: 1 })
    push("session.text.delta", { sessionID: S, assistantMessageID: M, ordinal: 0, delta: "hi" })
    await until(() => idle === 1, 2000)
    expect(server.requests.some((r) => r.path === "/api/session" && r.query.directory === "/ws")).toBe(true)
    subscription.abort()
  })

  it("discovers a subagent from a 2.0 session created under the parent", async () => {
    const backend = { url: server.url, api: createV2Api({ url: server.url, directory: "/ws", password: server.password }), directory: "/ws" } as Backend
    const discovered: Array<{ id: string; parentID?: string; title?: string }> = []
    const subscription = subscribeSession(backend, S, { onTextDelta: () => {}, onChildSessionDiscovered: (info) => discovered.push(info) }, { watchdogMs: 10_000 })
    await subscription.ready
    await server.awaitClient()
    push("session.created", { sessionID: "ses_child", projectID: "p", location: { directory: "/ws" }, parentID: S, slug: "worker", title: "Worker", version: "2" })
    push("session.created", { sessionID: "ses_unrelated", projectID: "p", location: { directory: "/ws" }, slug: "other", version: "2" })
    await until(() => discovered.length === 1)
    expect(discovered[0]).toEqual({ id: "ses_child", parentID: S, title: "Worker" })
    subscription.abort()
  })
})
