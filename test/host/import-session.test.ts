import { describe, expect, it } from "vitest"
import { externalSessionSummaries, importedMessages } from "../../src/chat/import-session"

describe("externalSessionSummaries", () => {
  const bound = new Set(["ses_bound"])
  it("filters child sessions and already-bound sessions, sorts newest first", () => {
    const out = externalSessionSummaries(
      [
        { id: "ses_old", title: "Old chat", time: { created: 100, updated: 200 } },
        { id: "ses_child", parentID: "ses_old", title: "subagent", time: { updated: 999 } },
        { id: "ses_bound", title: "Panel chat", time: { updated: 900 } },
        { id: "ses_new", title: "Fresh TUI chat", time: { updated: 500 } },
      ],
      bound,
    )
    expect(out).toEqual([
      { id: "ses_new", title: "Fresh TUI chat", updatedAt: 500 },
      { id: "ses_old", title: "Old chat", updatedAt: 200 },
    ])
  })

  it("falls back to created time and an Untitled label", () => {
    const out = externalSessionSummaries([{ id: "ses_x", title: "  ", time: { created: 42 } }], new Set())
    expect(out).toEqual([{ id: "ses_x", title: "Untitled session", updatedAt: 42 }])
  })

  it("caps the list", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      id: `ses_${i}`,
      title: `chat ${i}`,
      time: { updated: i },
    }))
    expect(externalSessionSummaries(many, new Set())).toHaveLength(50)
  })
})

describe("importedMessages", () => {
  it("rebuilds user and assistant messages with server ids as both id and backendID", () => {
    const out = importedMessages(
      [
        {
          info: { id: "msg_u1", role: "user" },
          parts: [
            { type: "text", text: "fix the bug" },
            { type: "text", text: "injected context", synthetic: true },
          ],
        },
        {
          info: { id: "msg_a1", role: "assistant" },
          parts: [
            { type: "reasoning", text: "thinking" },
            { type: "step-start" },
            {
              type: "tool",
              callID: "call_1",
              tool: "read",
              state: { status: "completed", title: "read file", input: { filePath: "/ws/a.ts" }, output: "ok" },
            },
            { type: "text", text: "done" },
          ],
        },
      ],
      "/ws",
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      id: "msg_u1",
      backendID: "msg_u1",
      role: "user",
      blocks: [{ type: "text", text: "fix the bug" }],
    })
    expect(out[1]!.blocks.map((b) => b.type)).toEqual(["reasoning", "tool", "text"])
    const tool = out[1]!.blocks[1]
    expect(tool.type === "tool" && tool.update.input?.filePath).toBe("a.ts")
  })

  it("drops unsettled tool parts from an interrupted session", () => {
    const out = importedMessages(
      [
        {
          info: { id: "msg_a", role: "assistant" },
          parts: [
            { type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: {} } },
            { type: "tool", callID: "c2", tool: "bash", state: { status: "error", input: {}, error: "boom" } },
          ],
        },
      ],
      "/ws",
    )
    expect(out[0]!.blocks).toHaveLength(1)
    const block = out[0]!.blocks[0]
    expect(block.type === "tool" && block.update.status).toBe("error")
  })

  it("maps MessageAbortedError to the Stopped badge, real errors to error text", () => {
    const out = importedMessages(
      [
        {
          info: { id: "msg_stop", role: "assistant", error: { name: "MessageAbortedError" } },
          parts: [{ type: "text", text: "partial" }],
        },
        {
          info: { id: "msg_err", role: "assistant", error: { name: "ApiError", data: { message: "rate limit" } } },
          parts: [{ type: "text", text: "partial" }],
        },
      ],
      "/ws",
    )
    expect(out[0]).toMatchObject({ stopped: true })
    expect(out[0]!.error).toBeUndefined()
    expect(out[1]).toMatchObject({ error: "rate limit" })
  })

  it("keeps the compaction summary flag and skips empty messages", () => {
    const out = importedMessages(
      [
        { info: { id: "msg_sum", role: "assistant", summary: true }, parts: [{ type: "text", text: "recap" }] },
        { info: { id: "msg_empty", role: "assistant" }, parts: [{ type: "step-start" }] },
        { info: { id: "msg_ctx", role: "user" }, parts: [{ type: "text", text: "ctx", synthetic: true }] },
      ],
      "/ws",
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: "msg_sum", summary: true })
  })

  it("relativizes patch part files against the backend directory", () => {
    const out = importedMessages(
      [
        {
          info: { id: "msg_p", role: "assistant" },
          parts: [{ type: "patch", files: ["/ws/src/a.ts", "/ws/b.ts"] }],
        },
      ],
      "/ws",
    )
    expect(out[0]!.blocks[0]).toEqual({ type: "patch", files: ["src/a.ts", "b.ts"] })
  })
})
