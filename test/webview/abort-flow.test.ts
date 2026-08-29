import { describe, it, expect } from "vitest"
import { reducer, initialChatState } from "../../webview/src/hooks/useChatState"

function pendingAssistant(id = "a1") {
  return reducer(
    { ...initialChatState, busy: true },
    { type: "assistantStart", id },
  )
}

describe("reducer abort flow", () => {
  it("aborted: enters aborting=true, keeps busy=true, marks pending assistants as stopped", () => {
    const before = pendingAssistant("a1")
    expect(before.busy).toBe(true)
    expect(before.aborting).toBe(false)
    const after = reducer(before, { type: "aborted" })
    expect(after.busy).toBe(true)
    expect(after.aborting).toBe(true)
    const msg = after.messages.find((m) => m.id === "a1")!
    expect(msg.pending).toBe(false)
    expect(msg.stopped).toBe(true)
    // Crucially, no `error` was set — Stop is not a failure.
    expect(msg.error).toBeUndefined()
  })

  it("aborted after sessionIdle (Stop raced completion) is a no-op — no wedge, no badge (#579)", () => {
    const idle = reducer(pendingAssistant("a1"), { type: "sessionIdle" })
    expect(idle.busy).toBe(false)
    const after = reducer(idle, { type: "aborted" })
    // Entering aborting here would stick forever: the already-idle session
    // emits no further sessionIdle to clear it.
    expect(after).toBe(idle)
    expect(after.aborting).toBe(false)
    expect(after.messages.find((m) => m.id === "a1")!.stopped).toBeUndefined()
  })

  it("sessionIdle after aborted: clears both busy and aborting", () => {
    const before = pendingAssistant()
    const aborted = reducer(before, { type: "aborted" })
    const idle = reducer(aborted, { type: "sessionIdle" })
    expect(idle.busy).toBe(false)
    expect(idle.aborting).toBe(false)
  })

  it("textDelta during aborting is dropped (no message mutation)", () => {
    const before = pendingAssistant()
    const aborted = reducer(before, { type: "aborted" })
    const next = reducer(aborted, { type: "textDelta", id: "a1", delta: "leftover" })
    expect(next).toBe(aborted) // reference-equal: reducer returned the same state
    const msg = next.messages.find((m) => m.id === "a1")!
    // No text block was appended.
    expect(msg.blocks.find((b) => b.type === "text" && b.text.includes("leftover"))).toBeUndefined()
  })

  it("reasoningDelta / non-terminal tool during aborting are also dropped", () => {
    const before = pendingAssistant()
    const aborted = reducer(before, { type: "aborted" })
    const after1 = reducer(aborted, { type: "reasoningDelta", id: "a1", delta: "x" })
    expect(after1).toBe(aborted)
    const after2 = reducer(aborted, {
      type: "tool",
      id: "a1",
      update: { callID: "c1", tool: "read", status: "running" },
    })
    expect(after2).toBe(aborted)
  })

  it("terminal tool closure during aborting IS applied (no perpetual 'running' block)", () => {
    const before = reducer(pendingAssistant(), {
      type: "tool",
      id: "a1",
      update: { callID: "c1", tool: "read", status: "running" },
    })
    const aborted = reducer(before, { type: "aborted" })
    const after = reducer(aborted, {
      type: "tool",
      id: "a1",
      update: { callID: "c1", tool: "read", status: "completed" },
    })
    const msg = after.messages.find((m) => m.id === "a1")!
    const tool = msg.blocks.find((b) => b.type === "tool")
    expect(tool?.type === "tool" && tool.update.status).toBe("completed")
  })

  it("patch during aborting IS applied (the disk mutation already happened)", () => {
    const aborted = reducer(pendingAssistant(), { type: "aborted" })
    const after = reducer(aborted, { type: "patch", id: "a1", files: ["foo.ts"], diff: "@@" })
    const msg = after.messages.find((m) => m.id === "a1")!
    expect(msg.blocks.find((b) => b.type === "patch")).toBeDefined()
  })

  it("textDelta when NOT aborting still appends normally (control test)", () => {
    const before = pendingAssistant()
    const next = reducer(before, { type: "textDelta", id: "a1", delta: "hello" })
    const msg = next.messages.find((m) => m.id === "a1")!
    const textBlock = msg.blocks.find((b) => b.type === "text")
    expect(textBlock).toBeDefined()
    expect(textBlock?.type === "text" && textBlock.text).toBe("hello")
  })

  it("Send button can re-enable: busy stays false once sessionIdle fires after abort", () => {
    const before = pendingAssistant()
    const after = reducer(reducer(before, { type: "aborted" }), { type: "sessionIdle" })
    expect(after.busy).toBe(false)
    expect(after.aborting).toBe(false)
  })

  it("aborted also clears pending permission", () => {
    const withPerm = reducer(
      pendingAssistant(),
      { type: "permission", id: "p1", title: "Allow run?" },
    )
    expect(withPerm.pendingPermission?.id).toBe("p1")
    const after = reducer(withPerm, { type: "aborted" })
    expect(after.pendingPermission).toBeUndefined()
  })

  it("aborted also clears a pending question", () => {
    const withQuestion = reducer(pendingAssistant(), {
      type: "question",
      id: "q1",
      questions: [{ question: "Pick", header: "Pick", options: [{ label: "A", description: "a" }] }],
    })
    expect(withQuestion.pendingQuestion?.id).toBe("q1")
    const after = reducer(withQuestion, { type: "aborted" })
    expect(after.pendingQuestion).toBeUndefined()
  })

  it("permission / question racing in DURING aborting are dropped (nothing could ever clear them)", () => {
    const aborted = reducer(pendingAssistant(), { type: "aborted" })
    const withPerm = reducer(aborted, { type: "permission", id: "p_late", title: "Allow?" })
    expect(withPerm).toBe(aborted)
    const withQuestion = reducer(aborted, {
      type: "question",
      id: "q_late",
      questions: [{ question: "Pick", header: "Pick", options: [{ label: "A", description: "a" }] }],
    })
    expect(withQuestion).toBe(aborted)
  })

  it("assistantError on an already-stopped message is suppressed (no red block)", () => {
    const before = pendingAssistant("a1")
    const aborted = reducer(before, { type: "aborted" })
    // Opencode later emits Aborted error for the same message.
    const after = reducer(aborted, { type: "assistantError", id: "a1", message: "Aborted" })
    expect(after).toBe(aborted)
    const msg = after.messages.find((m) => m.id === "a1")!
    expect(msg.error).toBeUndefined()
    expect(msg.stopped).toBe(true)
  })

  it("assistantError on a normal (not stopped) message still sets error", () => {
    const before = pendingAssistant("a2")
    const after = reducer(before, { type: "assistantError", id: "a2", message: "Network error" })
    const msg = after.messages.find((m) => m.id === "a2")!
    expect(msg.error).toBe("Network error")
    expect(msg.pending).toBe(false)
  })

  it("assistantStart while aborting is dropped (no stray empty bubble)", () => {
    const before = pendingAssistant("a1")
    const aborted = reducer(before, { type: "aborted" })
    // A late message.start races in after Stop.
    const after = reducer(aborted, { type: "assistantStart", id: "a2" })
    expect(after).toBe(aborted) // reference-equal: reducer returned the same state
    expect(after.messages.filter((m) => m.role === "assistant")).toHaveLength(1)
  })

  it("restore after aborted clears aborting + continuationPending (composer recovers)", () => {
    // Repro: user presses Stop, then switches conversations before the old
    // session's sessionIdle (the only thing that clears `aborting`) arrives.
    // Without the restore reset, `aborting` strands and PromptBox stays disabled.
    const aborted = reducer(pendingAssistant("a1"), { type: "aborted" })
    const pending = reducer(aborted, { type: "continuationPending", pending: true })
    expect(pending.aborting).toBe(true)
    expect(pending.continuationPending).toBe(true)
    const restored = reducer(pending, { type: "restore", conversationID: "c2", messages: [] })
    expect(restored.aborting).toBe(false)
    expect(restored.continuationPending).toBe(false)
    expect(restored.busy).toBe(false)
    expect(restored.conversationID).toBe("c2")
  })

  it("multiple pending assistants in a turn: only the LAST one gets the Stopped badge", () => {
    // Build a state with two pending assistants in the same turn (e.g. a
    // subtask intermediate step + the final answer).
    const s0 = reducer(
      { ...initialChatState, busy: true },
      { type: "assistantStart", id: "a1" },
    )
    const s1 = reducer(s0, { type: "assistantStart", id: "a2" })
    expect(s1.messages.filter((m) => m.role === "assistant" && m.pending)).toHaveLength(2)
    const after = reducer(s1, { type: "aborted" })
    const a1 = after.messages.find((m) => m.id === "a1")!
    const a2 = after.messages.find((m) => m.id === "a2")!
    // Both stop pending, but only the last one is badged stopped.
    expect(a1.pending).toBe(false)
    expect(a2.pending).toBe(false)
    expect(a1.stopped).toBeUndefined()
    expect(a2.stopped).toBe(true)
  })
})
