import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { MessageView } from "../../webview/src/components/MessageView"
import { reducer, initialChatState, type Message } from "../../webview/src/hooks/useChatState"

afterEach(cleanup)

function summaryMessage(text: string, opts: { pending?: boolean; stopped?: boolean; error?: string } = {}): Message {
  return {
    id: "a1",
    role: "assistant",
    blocks: text ? [{ type: "text", text }] : [],
    summary: true,
    ...opts,
  } as Message
}

describe("reducer: assistantSummary", () => {
  it("flags the target assistant message", () => {
    const started = reducer(initialChatState, { type: "assistantStart", id: "a1" })
    const flagged = reducer(started, { type: "assistantSummary", id: "a1" })
    expect(flagged.messages[0]).toMatchObject({ id: "a1", summary: true })
  })

  it("is dropped while aborting, like the other non-terminal stream events", () => {
    let state = reducer(initialChatState, { type: "assistantStart", id: "a1" })
    state = reducer(state, { type: "aborted" })
    const after = reducer(state, { type: "assistantSummary", id: "a1" })
    expect(after).toBe(state)
    expect(after.messages[0]!.summary).toBeUndefined()
  })
})

describe("MessageView: compaction marker", () => {
  it("renders a settled summary turn as a collapsed process-style row instead of a bubble", () => {
    const { container } = render(
      <MessageView message={summaryMessage("anchored summary body")} processOpen={false} processOnly={false} />,
    )
    expect(screen.getByText("Conversation compacted")).toBeInTheDocument()
    // Same visual idiom as tool traces / the process panel: the shared
    // process-* classes, collapsed by default.
    const marker = container.querySelector(".compaction-marker")
    expect(marker).not.toBeNull()
    expect(marker!.classList.contains("process")).toBe(true)
    expect(marker!.classList.contains("is-open")).toBe(false)
    expect(marker!.querySelector(".process-head")).not.toBeNull()
    // The summary content stays available behind the disclosure.
    expect(screen.getByText("anchored summary body")).toBeInTheDocument()
    expect(container.querySelector(".msg.role-assistant")).toBeNull()
  })

  it("toggles open on click like the other process rows", () => {
    const { container } = render(
      <MessageView message={summaryMessage("anchored summary body")} processOpen={false} processOnly={false} />,
    )
    const head = container.querySelector<HTMLButtonElement>(".compaction-marker .process-head")!
    fireEvent.click(head)
    expect(container.querySelector(".compaction-marker")!.classList.contains("is-open")).toBe(true)
    expect(head.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(head)
    expect(container.querySelector(".compaction-marker")!.classList.contains("is-open")).toBe(false)
  })

  it("labels a still-streaming summary turn as compacting", () => {
    render(<MessageView message={summaryMessage("", { pending: true })} processOpen={false} processOnly={false} />)
    expect(screen.getByText("Compacting conversation…")).toBeInTheDocument()
  })

  it("falls back to the Stopped badge when the compaction was interrupted", () => {
    const { container } = render(
      <MessageView message={summaryMessage("partial", { stopped: true })} processOpen={false} processOnly={false} />,
    )
    expect(container.querySelector(".compaction-marker")).toBeNull()
    expect(screen.getByText("Stopped")).toBeInTheDocument()
  })

  it("falls back to the error block when the compaction failed", () => {
    const { container } = render(
      <MessageView message={summaryMessage("", { error: "rate limit exceeded" })} processOpen={false} processOnly={false} />,
    )
    expect(container.querySelector(".compaction-marker")).toBeNull()
    expect(screen.getByText("rate limit exceeded")).toBeInTheDocument()
  })

  it("leaves normal assistant messages untouched", () => {
    const normal = {
      id: "a2",
      role: "assistant",
      blocks: [{ type: "text", text: "plain reply" }],
    } as Message
    const { container } = render(<MessageView message={normal} processOpen={false} processOnly={false} />)
    expect(container.querySelector(".compaction-marker")).toBeNull()
    expect(screen.getByText("plain reply")).toBeInTheDocument()
  })
})
