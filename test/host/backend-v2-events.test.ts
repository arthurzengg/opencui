import { describe, expect, it } from "vitest"
import type { OpenCodeEvent } from "@opencode/client/promise"
import { createEventTranslator, formAnswer, translateEvents } from "../../src/backend/v2/events"

let seq = 0
const ev = <T extends OpenCodeEvent["type"]>(type: T, data: Extract<OpenCodeEvent, { type: T }>["data"]): OpenCodeEvent =>
  ({ id: `evt_${++seq}`, created: 1000 + seq, type, data }) as unknown as OpenCodeEvent

const S = "ses_1"
const M = "msg_a1"
const model = { id: "claude-sonnet-5", providerID: "anthropic" }
const tokens = { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }

describe("opencode 2.0 event translator (#684)", () => {
  it("narrates a step as an assistant message with text and reasoning spans", () => {
    const t = createEventTranslator().translate
    expect(t(ev("session.step.started", { sessionID: S, assistantMessageID: M, agent: "build", model, started: 5 }))).toEqual([
      { type: "message.updated", properties: { info: { id: M, sessionID: S, role: "assistant", time: { created: 5 }, modelID: "claude-sonnet-5", providerID: "anthropic", mode: "build", parentID: "" } } },
    ])
    expect(t(ev("session.reasoning.started", { sessionID: S, assistantMessageID: M, ordinal: 0 }))).toEqual([
      { type: "message.part.updated", properties: { part: { id: `${M}:reasoning:0`, sessionID: S, messageID: M, type: "reasoning", text: "" } } },
    ])
    expect(t(ev("session.text.delta", { sessionID: S, assistantMessageID: M, ordinal: 1, delta: "Hel" }))).toEqual([
      { type: "message.part.delta", properties: { sessionID: S, messageID: M, partID: `${M}:text:1`, field: "text", delta: "Hel" } },
    ])
    expect(t(ev("session.text.ended", { sessionID: S, assistantMessageID: M, ordinal: 1, text: "Hello" }))).toEqual([
      { type: "message.part.updated", properties: { part: { id: `${M}:text:1`, sessionID: S, messageID: M, type: "text", text: "Hello" } } },
    ])
  })

  it("carries a tool call through pending, running, and completed with its name and input", () => {
    const t = createEventTranslator().translate
    expect(t(ev("session.tool.input.started", { sessionID: S, assistantMessageID: M, id: "call_1", name: "read" }))).toEqual([
      { type: "message.part.updated", properties: { part: { id: "call_1", sessionID: S, messageID: M, type: "tool", callID: "call_1", tool: "read", state: { status: "pending", input: {}, raw: "" } } } },
    ])
    const running = t(ev("session.tool.called", { sessionID: S, assistantMessageID: M, id: "call_1", input: { filePath: "a.ts" }, executed: true }))
    expect(running[0]!.properties).toMatchObject({ part: { tool: "read", state: { status: "running", input: { filePath: "a.ts" } } } })
    const done = t(ev("session.tool.success", { sessionID: S, assistantMessageID: M, id: "call_1", content: [{ type: "text", text: "l1" }, { type: "text", text: "l2" }], executed: true }))
    expect(done[0]!.properties).toMatchObject({ part: { callID: "call_1", tool: "read", state: { status: "completed", input: { filePath: "a.ts" }, output: "l1\nl2", title: "read" } } })
    expect(t(ev("session.tool.success", { sessionID: S, assistantMessageID: M, id: "call_1", content: [{ type: "text", text: "again" }], executed: true }))).toEqual([])
  })

  it("turns a failed tool into an error state and an unknown tool into nothing", () => {
    const t = createEventTranslator().translate
    t(ev("session.tool.input.started", { sessionID: S, assistantMessageID: M, id: "call_2", name: "bash" }))
    t(ev("session.tool.called", { sessionID: S, assistantMessageID: M, id: "call_2", input: { command: "false" }, executed: true }))
    const failed = t(ev("session.tool.failed", { sessionID: S, assistantMessageID: M, id: "call_2", error: { type: "ToolError", message: "exit 1" }, executed: true }))
    expect(failed[0]!.properties).toMatchObject({ part: { state: { status: "error", input: { command: "false" }, error: "exit 1" } } })
    expect(t(ev("session.tool.called", { sessionID: S, assistantMessageID: M, id: "call_9", input: {}, executed: true }))).toEqual([])
  })

  it("ends a step with the finish, usage, and any files it wrote as a patch", () => {
    const t = createEventTranslator().translate
    const out = t(ev("session.step.ended", { sessionID: S, assistantMessageID: M, finish: "stop", cost: 0.5, tokens, files: ["src/a.ts"] }))
    expect(out).toHaveLength(2)
    expect(out[0]!.properties).toMatchObject({ part: { type: "patch", files: ["src/a.ts"], messageID: M } })
    expect(out[1]!.properties).toMatchObject({ info: { id: M, finish: "stop", cost: 0.5, tokens } })
    expect(t(ev("session.step.failed", { sessionID: S, assistantMessageID: M, error: { type: "ProviderError", message: "rate limited" } }))[0]!.properties)
      .toMatchObject({ info: { id: M, finish: "error", error: { name: "ProviderError", data: { message: "rate limited" } } } })
  })

  it("maps execution and session lifecycle to status, error, abort, and idle", () => {
    const t = createEventTranslator().translate
    expect(t(ev("session.execution.started", { sessionID: S }))).toEqual([{ type: "session.status", properties: { sessionID: S, status: { type: "busy" } } }])
    expect(t(ev("session.execution.failed", { sessionID: S, error: { type: "ProviderError", message: "boom" } }))).toEqual([
      { type: "session.error", properties: { sessionID: S, error: { name: "ProviderError", data: { message: "boom" } } } },
      { type: "session.idle", properties: { sessionID: S } },
    ])
    expect(t(ev("session.execution.interrupted", { sessionID: S, reason: "user" }))).toEqual([{ type: "session.idle", properties: { sessionID: S } }])
    t(ev("session.step.started", { sessionID: S, assistantMessageID: M, agent: "build", model, started: 1 }))
    const interrupted = t(ev("session.execution.interrupted", { sessionID: S, reason: "user" }))
    expect(interrupted[0]!.properties).toMatchObject({ info: { id: M, error: { name: "MessageAbortedError" } } })
    expect(interrupted[1]).toEqual({ type: "session.idle", properties: { sessionID: S } })
    expect(t(ev("session.retry.scheduled", { sessionID: S, assistantMessageID: M, attempt: 2, at: 99, error: { type: "ProviderError", message: "overloaded" } }))).toEqual([
      { type: "session.status", properties: { sessionID: S, status: { type: "retry", attempt: 2, message: "overloaded", next: 99 } } },
    ])
    // The interruption already ended the turn; the idle that follows is dropped.
    expect(t(ev("session.idle", { sessionID: S }))).toEqual([])
    expect(t(ev("session.execution.interrupted", { sessionID: S, reason: "user" }))).toEqual([{ type: "session.idle", properties: { sessionID: S } }])
  })

  // A live run ended an execution without a session.idle, and the host reads
  // idle as the end of the turn; a second idle would flush a second queued
  // message, so one that does follow is dropped.
  it("ends the turn when the execution ends, once", () => {
    const t = createEventTranslator().translate
    t(ev("session.execution.started", { sessionID: S }))
    expect(t(ev("session.execution.succeeded", { sessionID: S }))).toEqual([{ type: "session.idle", properties: { sessionID: S } }])
    expect(t(ev("session.idle", { sessionID: S }))).toEqual([])
    t(ev("session.execution.started", { sessionID: S }))
    expect(t(ev("session.execution.failed", { sessionID: S, error: { type: "ProviderError", message: "boom" } })).map((e) => e.type)).toEqual(["session.error", "session.idle"])
    t(ev("session.execution.started", { sessionID: S }))
    expect(t(ev("session.idle", { sessionID: S }))).toEqual([{ type: "session.idle", properties: { sessionID: S } }])
  })

  it("surfaces a compaction as a summary message, and sessions as created and renamed", () => {
    const t = createEventTranslator().translate
    const out = t(ev("session.compaction.ended", { sessionID: S, reason: "auto", text: "Summary so far", recent: "" }))
    expect(out.map((e) => e.type)).toEqual(["message.updated", "message.part.updated", "message.updated"])
    expect(out[0]!.properties).toMatchObject({ info: { sessionID: S, role: "assistant", summary: true } })
    expect(out[1]!.properties).toMatchObject({ part: { type: "text", text: "Summary so far" } })
    expect(out[2]!.properties).toMatchObject({ info: { summary: true, finish: "stop" } })
    expect(t(ev("session.created", { sessionID: "ses_child", projectID: "p", location: { directory: "/ws" }, parentID: S, slug: "x", title: "Worker", version: "2" }))).toEqual([
      { type: "session.created", properties: { info: { id: "ses_child", parentID: S, title: "Worker" } } },
    ])
    expect(t(ev("session.renamed", { sessionID: S, title: "New name" }))).toEqual([{ type: "session.updated", properties: { info: { id: S, title: "New name" } } }])
    expect(t(ev("server.connected", {} as never))).toEqual([{ type: "server.connected", properties: {} }])
    for (const type of ["command.updated", "provider.updated", "model.updated", "agent.updated"] as const) {
      expect(t(ev(type, {} as never))).toEqual([{ type: "catalog.updated", properties: {} }])
    }
    expect(t({ id: "evt_x", created: 1, type: "pty.created", data: {} } as unknown as OpenCodeEvent)).toEqual([])
  })

  it("asks a permission in the 1.18 shape and remembers which session to answer", () => {
    const translator = createEventTranslator()
    const asked = translator.translate(ev("permission.asked", { id: "req_1", sessionID: S, action: "bash", resources: ["rm -rf build"], save: ["rm *"], message: "Run rm?", source: { type: "tool", messageID: M, id: "call_1" } }))
    expect(asked).toEqual([{
      type: "permission.asked",
      properties: expect.objectContaining({ id: "req_1", sessionID: S, permission: "bash", patterns: ["rm -rf build"], always: ["rm *"], title: "Run rm?", messageID: M, callID: "call_1" }),
    }])
    expect(translator.sessionForPermission("req_1")).toBe(S)
    expect(translator.translate(ev("permission.replied", { sessionID: S, requestID: "req_1", reply: "once" }))).toEqual([
      { type: "permission.replied", properties: { sessionID: S, requestID: "req_1", reply: "once" } },
    ])
    expect(translator.sessionForPermission("req_1")).toBeUndefined()
    expect(translator.translate(ev("permission.asked", { id: "req_2", sessionID: S, action: "edit", resources: ["a.ts"] }))[0]!.properties).toMatchObject({ title: "Permission needed: edit", always: [] })
  })

  it("shows a form as questions and maps the answers back by field", () => {
    const translator = createEventTranslator()
    const form = {
      id: "form_1",
      sessionID: S,
      title: "Deploy settings",
      fields: [
        { key: "env", type: "string" as const, title: "Environment", options: [{ value: "prod", label: "Production", description: "Live" }, { value: "stage", label: "Staging" }] },
        { key: "regions", type: "multiselect" as const, title: "Regions", options: [{ value: "us", label: "US" }, { value: "eu", label: "EU" }], custom: true },
        { key: "confirm", type: "boolean" as const, title: "Really?", description: "Deploy now" },
        { key: "replicas", type: "number" as const, title: "Replicas" },
      ],
    }
    const asked = translator.translate(ev("form.created", { form }))
    expect(asked).toHaveLength(1)
    expect(asked[0]!.type).toBe("question.asked")
    const questions = (asked[0]!.properties as { questions: Array<Record<string, unknown>> }).questions
    expect(questions).toEqual([
      { question: "Environment", header: "Environment", options: [{ label: "Production", description: "Live" }, { label: "Staging", description: "" }], multiple: false, custom: false },
      { question: "Regions", header: "Regions", options: [{ label: "US", description: "" }, { label: "EU", description: "" }], multiple: true, custom: true },
      { question: "Deploy now", header: "Really?", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], custom: false },
      { question: "Replicas", header: "Replicas", options: [], custom: true },
    ])
    expect(formAnswer(translator.form("form_1")!, [["Staging"], ["US", "ap-south"], ["Yes"], ["3"]])).toEqual({ env: "stage", regions: ["us", "ap-south"], confirm: true, replicas: 3 })
    expect(translator.translate(ev("form.cancelled", { id: "form_1", sessionID: S }))).toEqual([{ type: "question.rejected", properties: { sessionID: S, requestID: "form_1" } }])
    expect(translator.form("form_1")).toBeUndefined()
    translator.translate(ev("form.created", { form }))
    expect(translator.translate(ev("form.replied", { id: "form_1", sessionID: S, answer: { env: "prod" } }))).toEqual([{ type: "question.replied", properties: { sessionID: S, requestID: "form_1" } }])
  })

  it("flattens a stream of 2.0 events into 1.x-shaped ones", async () => {
    async function* source() {
      yield ev("session.step.started", { sessionID: S, assistantMessageID: M, agent: "build", model, started: 1 })
      yield ev("session.step.ended", { sessionID: S, assistantMessageID: M, finish: "stop", cost: 0, tokens, files: ["a"] })
    }
    const out: string[] = []
    for await (const e of translateEvents(createEventTranslator(), source())) out.push(e.type)
    expect(out).toEqual(["message.updated", "message.part.updated", "message.updated"])
  })
})
