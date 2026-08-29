import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, renderHook } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  reducer,
  initialChatState,
  type ChatState,
  type QueuedMessage,
} from "../../webview/src/hooks/useChatState"
import { useQueueFlush } from "../../webview/src/hooks/useQueueFlush"
import { QueuedMessages } from "../../webview/src/components/QueuedMessages"

afterEach(cleanup)

function q(id: string, text = `text of ${id}`): QueuedMessage {
  return { id, text }
}

describe("reducer queue transitions", () => {
  it("queueMessage appends in order; unqueueMessage removes by id", () => {
    let state = reducer(initialChatState, { type: "queueMessage", message: q("q1") })
    state = reducer(state, { type: "queueMessage", message: q("q2") })
    expect(state.queued.map((m) => m.id)).toEqual(["q1", "q2"])
    state = reducer(state, { type: "unqueueMessage", id: "q1" })
    expect(state.queued.map((m) => m.id)).toEqual(["q2"])
  })

  it("sessionIdle bumps idleNonce — the only flush trigger", () => {
    const idle = reducer(initialChatState, { type: "sessionIdle" })
    expect(idle.idleNonce).toBe(1)
    expect(reducer(idle, { type: "sessionIdle" }).idleNonce).toBe(2)
  })

  it("assistantDone does NOT bump idleNonce (busy flickers false mid-turn; flushing there would inject the prompt between assistant messages)", () => {
    const state = reducer(initialChatState, { type: "queueMessage", message: q("q1") })
    const done = reducer(state, { type: "assistantDone", id: "a1" })
    expect(done.idleNonce).toBe(state.idleNonce)
    expect(done.queued).toEqual(state.queued)
  })

  it("aborted clears the queue — Stop must not auto-restart work via a queued follow-up", () => {
    // Queueing only happens while busy; `aborted` at idle is a no-op (#579).
    const state = reducer({ ...initialChatState, busy: true }, { type: "queueMessage", message: q("q1") })
    expect(reducer(state, { type: "aborted" }).queued).toEqual([])
  })

  it("messages queued AFTER Stop (during the drain) survive to the idle flush", () => {
    let state = reducer(initialChatState, { type: "aborted" })
    state = reducer(state, { type: "queueMessage", message: q("q_post_stop") })
    const idle = reducer(state, { type: "sessionIdle" })
    expect(idle.queued.map((m) => m.id)).toEqual(["q_post_stop"])
    expect(idle.aborting).toBe(false)
  })

  it("restore (conversation switch) drops the queue", () => {
    const state = reducer(initialChatState, { type: "queueMessage", message: q("q1") })
    const restored = reducer(state, {
      type: "restore",
      conversationID: "conv2",
      messages: [],
    })
    expect(restored.queued).toEqual([])
  })

  it("clear and reset preserve idleNonce so the flush hook's last-seen ref never desyncs", () => {
    let state: ChatState = initialChatState
    for (let i = 0; i < 3; i++) state = reducer(state, { type: "sessionIdle" })
    expect(reducer(state, { type: "clear" }).idleNonce).toBe(3)
    expect(reducer(state, { type: "reset" }).idleNonce).toBe(3)
  })
})

type FlushState = Pick<ChatState, "idleNonce" | "queued" | "aborting" | "continuationPending">

const flushBase: FlushState = {
  idleNonce: 0,
  queued: [],
  aborting: false,
  continuationPending: false,
}

function renderFlush(initial: FlushState) {
  const deliver = vi.fn()
  const view = renderHook(({ s }: { s: FlushState }) => useQueueFlush(s, deliver), {
    initialProps: { s: initial },
  })
  return { deliver, rerender: (s: FlushState) => view.rerender({ s }) }
}

describe("useQueueFlush", () => {
  it("delivers the oldest queued message when idleNonce bumps", () => {
    const start = { ...flushBase, queued: [q("q1"), q("q2")] }
    const { deliver, rerender } = renderFlush(start)
    expect(deliver).not.toHaveBeenCalled()
    rerender({ ...start, idleNonce: 1 })
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith(q("q1"))
  })

  it("queue changes at the same nonce do not deliver again (no double-fire from the unqueue re-render)", () => {
    const start = { ...flushBase, queued: [q("q1"), q("q2")] }
    const { deliver, rerender } = renderFlush(start)
    rerender({ ...start, idleNonce: 1 })
    rerender({ ...flushBase, idleNonce: 1, queued: [q("q2")] })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("delivers one message per idle: the next idle flushes the next message", () => {
    const start = { ...flushBase, queued: [q("q1"), q("q2")] }
    const { deliver, rerender } = renderFlush(start)
    rerender({ ...start, idleNonce: 1 })
    rerender({ ...flushBase, idleNonce: 1, queued: [q("q2")] })
    rerender({ ...flushBase, idleNonce: 2, queued: [q("q2")] })
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(deliver).toHaveBeenLastCalledWith(q("q2"))
  })

  it("does not deliver on mount even with a non-zero nonce (remounted webview must not flush an idle it never observed)", () => {
    const { deliver } = renderFlush({ ...flushBase, idleNonce: 5, queued: [q("q1")] })
    expect(deliver).not.toHaveBeenCalled()
  })

  it("skips (and consumes) an idle that arrives while aborting or continuation-pending", () => {
    const start = { ...flushBase, queued: [q("q1")] }
    const { deliver, rerender } = renderFlush(start)
    rerender({ ...start, idleNonce: 1, aborting: true })
    expect(deliver).not.toHaveBeenCalled()
    rerender({ ...start, idleNonce: 1 })
    expect(deliver).not.toHaveBeenCalled()
    rerender({ ...start, idleNonce: 2 })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("an idle with an empty queue is a no-op", () => {
    const { deliver, rerender } = renderFlush(flushBase)
    rerender({ ...flushBase, idleNonce: 1 })
    expect(deliver).not.toHaveBeenCalled()
  })
})

describe("QueuedMessages", () => {
  it("renders nothing when the queue is empty", () => {
    const { container } = render(<QueuedMessages queued={[]} onRemove={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it("lists queued texts in order with a remove button per row", async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(
      <QueuedMessages queued={[q("q1", "run the tests"), q("q2", "then lint")]} onRemove={onRemove} />,
    )
    const rows = screen.getAllByRole("listitem")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent("run the tests")
    expect(rows[1]).toHaveTextContent("then lint")
    await user.click(screen.getAllByRole("button", { name: "Remove queued message" })[0])
    expect(onRemove).toHaveBeenCalledWith("q1")
  })

  it("summarizes attachments in the row label", () => {
    const attachment = { id: "att1", mime: "image/png", filename: "shot.png", dataUrl: "data:", bytes: 10 }
    render(
      <QueuedMessages
        queued={[
          { id: "q1", text: "look at this", attachments: [attachment, { ...attachment, id: "att2" }] },
          { id: "q2", text: "", attachments: [attachment] },
        ]}
        onRemove={vi.fn()}
      />,
    )
    const rows = screen.getAllByRole("listitem")
    expect(rows[0]).toHaveTextContent("look at this · 2 attachments")
    expect(rows[1]).toHaveTextContent("1 attachment")
  })
})
