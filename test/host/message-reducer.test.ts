import { describe, it, expect } from "vitest"
import { reduceLocal, type ReducerState } from "../../src/chat/message-reducer"
import type { ChatMessage, Outbound } from "../../src/protocol"

function state(messages: ChatMessage[] = [], reviewHunks: ReducerState["reviewHunks"] = {}): ReducerState {
  return { messages, reviewHunks }
}

const assistantPending = (id: string): ChatMessage => ({ id, role: "assistant", blocks: [], pending: true })

describe("reduceLocal", () => {
  it("returns null for a message that is not a local-state mutation", () => {
    expect(reduceLocal(state(), { type: "sessionBusy" } as Outbound)).toBeNull()
  })

  it("restore hydrates messages (pending cleared) + reviewHunks, syncs decorations, no save", () => {
    const msg: Outbound = {
      type: "restore",
      conversationID: "c1",
      messages: [assistantPending("a1")],
      reviewHunks: { k1: { decision: "accepted" } as never },
    }
    const next = reduceLocal(state(), msg)
    expect(next).not.toBeNull()
    expect(next!.messages[0]?.pending).toBe(false)
    expect(next!.reviewHunks).toEqual({ k1: { decision: "accepted" } })
    expect(next!.save).toBe(false)
    expect(next!.syncDecorations).toBe(true)
  })

  it("clear empties messages + reviewHunks and saves", () => {
    const next = reduceLocal(state([assistantPending("a1")], { k: {} as never }), { type: "clear" })
    expect(next).toMatchObject({ messages: [], reviewHunks: {}, save: true, syncDecorations: false })
  })

  it("userMessage appends a user bubble with attachments before the text block", () => {
    const msg: Outbound = {
      type: "userMessage",
      id: "u1",
      text: "hi",
      attachments: [{ mime: "image/png", filename: "a.png", dataUrl: "data:...", bytes: 3 }],
    }
    const next = reduceLocal(state(), msg)!
    const blocks = next.messages[0]!.blocks
    expect(blocks[0]).toMatchObject({ type: "attachment", filename: "a.png" })
    expect(blocks[1]).toMatchObject({ type: "text", text: "hi" })
    expect(next.save).toBe(true)
  })

  it("userMessageBackendID stamps the backendID on the matching message", () => {
    const next = reduceLocal(state([{ id: "u1", role: "user", blocks: [] }]), {
      type: "userMessageBackendID",
      id: "u1",
      backendID: "b1",
    })!
    expect(next.messages[0]!.backendID).toBe("b1")
  })

  it("assistantStart appends a pending assistant message", () => {
    const next = reduceLocal(state(), { type: "assistantStart", id: "a1" })!
    expect(next.messages[0]).toMatchObject({ id: "a1", role: "assistant", pending: true })
  })

  it("textDelta appends/merges into a trailing text block", () => {
    let s = state([{ id: "a1", role: "assistant", blocks: [] }])
    s = reduceLocal(s, { type: "textDelta", id: "a1", delta: "He" })!
    s = reduceLocal(s, { type: "textDelta", id: "a1", delta: "llo" })!
    expect(s.messages[0]!.blocks).toEqual([{ type: "text", text: "Hello" }])
  })

  it("tool upserts by callID and requests a decoration sync", () => {
    const update = { callID: "t1", name: "edit" } as never
    const next = reduceLocal(state([{ id: "a1", role: "assistant", blocks: [] }]), {
      type: "tool",
      id: "a1",
      update,
    })!
    expect(next.messages[0]!.blocks[0]).toMatchObject({ type: "tool" })
    expect(next.syncDecorations).toBe(true)
  })

  it("patch appends a patch block and requests a decoration sync", () => {
    const next = reduceLocal(state([{ id: "a1", role: "assistant", blocks: [] }]), {
      type: "patch",
      id: "a1",
      files: ["x.ts"],
      diff: "@@",
    })!
    expect(next.messages[0]!.blocks[0]).toMatchObject({ type: "patch", files: ["x.ts"] })
    expect(next.syncDecorations).toBe(true)
  })

  it("reviewHunkState sets and deletes by key without touching messages", () => {
    const msgs = [{ id: "a1", role: "assistant" as const, blocks: [] }]
    const set = reduceLocal(state(msgs), { type: "reviewHunkState", key: "k1", state: { decision: "accepted" } as never })!
    expect(set.reviewHunks).toEqual({ k1: { decision: "accepted" } })
    expect(set.messages).toBe(msgs)
    const cleared = reduceLocal(set, { type: "reviewHunkState", key: "k1" })!
    expect(cleared.reviewHunks).toEqual({})
  })

  it("assistantError sets the error and clears pending", () => {
    const next = reduceLocal(state([assistantPending("a1")]), {
      type: "assistantError",
      id: "a1",
      message: "boom",
    })!
    expect(next.messages[0]).toMatchObject({ error: "boom", pending: false })
  })

  it("assistantDone clears pending and records usage", () => {
    const usage = { input: 1, output: 2 } as never
    const next = reduceLocal(state([assistantPending("a1")]), { type: "assistantDone", id: "a1", usage })!
    expect(next.messages[0]).toMatchObject({ pending: false, usage })
  })

  it("aborted marks only the LAST pending assistant as stopped", () => {
    const next = reduceLocal(state([assistantPending("a1"), assistantPending("a2")]), { type: "aborted" })!
    expect(next.messages[0]!.pending).toBe(false)
    expect(next.messages[0]!.stopped).toBeUndefined()
    expect(next.messages[1]).toMatchObject({ pending: false, stopped: true })
  })

  it("sessionIdle clears pending on assistant messages without stopping them", () => {
    const next = reduceLocal(state([assistantPending("a1")]), { type: "sessionIdle" })!
    expect(next.messages[0]!.pending).toBe(false)
    expect(next.messages[0]!.stopped).toBeUndefined()
  })
})
