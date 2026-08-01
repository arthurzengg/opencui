import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PromptBox } from "../../webview/src/components/PromptBox"
import { promptHistory, caretAtFirstLine, caretAtLastLine } from "../../webview/src/prompt-history"
import type { ChatMessage } from "../../webview/src/protocol"

afterEach(cleanup)

function userMessage(id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "user", blocks: [{ type: "text", text }], ...extra }
}

/** Oldest first, matching the prop contract. */
const HISTORY = [{ text: "first prompt" }, { text: "second prompt" }, { text: "third prompt" }]

function renderComposer(props: Partial<React.ComponentProps<typeof PromptBox>> = {}) {
  const result = render(
    <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} history={HISTORY} {...props} />,
  )
  return { ...result, textarea: screen.getByRole("textbox") as HTMLTextAreaElement }
}

function press(textarea: HTMLTextAreaElement, key: string, init: Record<string, unknown> = {}) {
  fireEvent.keyDown(textarea, { key, ...init })
}

describe("promptHistory", () => {
  it("collects user prompts oldest-first and ignores assistant turns", () => {
    const entries = promptHistory([
      userMessage("u1", "one"),
      { id: "a1", role: "assistant", blocks: [{ type: "text", text: "reply" }] },
      userMessage("u2", "two"),
    ])
    expect(entries.map((e) => e.text)).toEqual(["one", "two"])
  })

  it("skips blank prompts", () => {
    // An attachment-only turn has no recallable text; offering an empty entry
    // would make Up look broken.
    const entries = promptHistory([userMessage("u1", "   "), userMessage("u2", "real")])
    expect(entries.map((e) => e.text)).toEqual(["real"])
  })

  it("collapses an immediately repeated prompt", () => {
    const entries = promptHistory([
      userMessage("u1", "retry me"),
      userMessage("u2", "retry me"),
      userMessage("u3", "different"),
    ])
    expect(entries.map((e) => e.text)).toEqual(["retry me", "different"])
  })

  it("carries mention bindings so recall can re-register them", () => {
    const entries = promptHistory([
      userMessage("u1", "look @src/a.ts", {
        mentions: ["src/a.ts"],
        conversationMentions: [{ label: "Past chat", id: "conv_1" }],
      }),
    ])
    expect(entries[0]!.mentions).toEqual(["src/a.ts"])
    expect(entries[0]!.conversationMentions).toEqual([{ label: "Past chat", id: "conv_1" }])
  })

  it("joins multiple text blocks the way the edit flow does", () => {
    const entries = promptHistory([
      { id: "u1", role: "user", blocks: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    ])
    expect(entries[0]!.text).toBe("a\n\nb")
  })
})

describe("caret edge predicates", () => {
  it("treats a soft-wrapped single logical line as the first and last line", () => {
    const long = "x".repeat(400)
    expect(caretAtFirstLine(long, 200)).toBe(true)
    expect(caretAtLastLine(long, 200)).toBe(true)
  })

  it("locates the caret between logical lines", () => {
    const text = "line one\nline two"
    expect(caretAtFirstLine(text, 4)).toBe(true)
    expect(caretAtLastLine(text, 4)).toBe(false)
    expect(caretAtFirstLine(text, 12)).toBe(false)
    expect(caretAtLastLine(text, 12)).toBe(true)
  })
})

describe("PromptBox prompt history", () => {
  it("Up recalls the most recent prompt, then walks further back", () => {
    const { textarea } = renderComposer()
    press(textarea, "ArrowUp")
    expect(textarea.value).toBe("third prompt")
    press(textarea, "ArrowUp")
    expect(textarea.value).toBe("second prompt")
    press(textarea, "ArrowUp")
    expect(textarea.value).toBe("first prompt")
  })

  it("stops at the oldest entry instead of wrapping", () => {
    const { textarea } = renderComposer()
    for (let i = 0; i < 6; i += 1) press(textarea, "ArrowUp")
    expect(textarea.value).toBe("first prompt")
  })

  it("Down walks forward and restores the stashed draft at the end", async () => {
    const user = userEvent.setup()
    const { textarea } = renderComposer()
    await user.type(textarea, "half-written")

    press(textarea, "ArrowUp")
    press(textarea, "ArrowUp")
    expect(textarea.value).toBe("second prompt")

    press(textarea, "ArrowDown")
    expect(textarea.value).toBe("third prompt")
    press(textarea, "ArrowDown")
    // Past the newest entry: the draft comes back rather than being destroyed.
    expect(textarea.value).toBe("half-written")
  })

  it("leaves Down alone in a composer that never entered history", async () => {
    const user = userEvent.setup()
    const { textarea } = renderComposer()
    await user.type(textarea, "typing")
    press(textarea, "ArrowDown")
    expect(textarea.value).toBe("typing")
  })

  it("typing after a recall re-stashes, so the next Up starts from the newest again", async () => {
    const user = userEvent.setup()
    const { textarea } = renderComposer()
    press(textarea, "ArrowUp")
    press(textarea, "ArrowUp")
    expect(textarea.value).toBe("second prompt")

    await user.type(textarea, "!")
    expect(textarea.value).toBe("second prompt!")
    press(textarea, "ArrowUp")
    expect(textarea.value).toBe("third prompt")
  })
})

describe("PromptBox prompt history — keys it must not steal", () => {
  it("moves the caret instead of recalling when another line is above", async () => {
    const user = userEvent.setup()
    const { textarea } = renderComposer()
    await user.type(textarea, "line one{Shift>}{Enter}{/Shift}line two")
    expect(textarea.value).toBe("line one\nline two")

    // Caret sits in the second line, so Up belongs to the textarea.
    textarea.setSelectionRange(12, 12)
    press(textarea, "ArrowUp")
    expect(textarea.value).toBe("line one\nline two")
  })

  it("recalls once the caret reaches the first line of a multi-line draft", async () => {
    const user = userEvent.setup()
    const { textarea } = renderComposer()
    await user.type(textarea, "line one{Shift>}{Enter}{/Shift}line two")
    textarea.setSelectionRange(3, 3)
    press(textarea, "ArrowUp")
    expect(textarea.value).toBe("third prompt")
  })

  it("ignores modifier chords", () => {
    const { textarea } = renderComposer()
    press(textarea, "ArrowUp", { shiftKey: true })
    expect(textarea.value).toBe("")
    press(textarea, "ArrowUp", { altKey: true })
    expect(textarea.value).toBe("")
    press(textarea, "ArrowUp", { metaKey: true })
    expect(textarea.value).toBe("")
  })

  it("ignores Up while text is selected", async () => {
    const user = userEvent.setup()
    const { textarea } = renderComposer()
    await user.type(textarea, "selected")
    textarea.setSelectionRange(0, 8)
    press(textarea, "ArrowUp")
    expect(textarea.value).toBe("selected")
  })

  it("is inert during IME composition", () => {
    const { textarea } = renderComposer()
    fireEvent.keyDown(textarea, { key: "ArrowUp", keyCode: 229 })
    expect(textarea.value).toBe("")
  })

  it("does not apply to the edit composer", () => {
    render(
      <PromptBox
        busy={false}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        variant="edit"
        initial={{ text: "editing this" }}
        history={HISTORY}
      />,
    )
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    press(textarea, "ArrowUp")
    expect(textarea.value).toBe("editing this")
  })

  it("yields the arrows to an open picker", async () => {
    const user = userEvent.setup()
    const searchFiles = vi.fn().mockResolvedValue([{ path: "src/foo.ts", name: "foo.ts" }])
    const { textarea } = renderComposer({ searchFiles })
    await user.type(textarea, "@")
    await waitFor(() => expect(screen.getByText("Files")).toBeInTheDocument())
    // The category menu owns Up/Down while it is open — history must not fire.
    press(textarea, "ArrowUp")
    expect(textarea.value).toBe("@")
  })
})

describe("PromptBox prompt history — mention fidelity", () => {
  it("re-registers recalled mentions so the chip paints", async () => {
    const { container, textarea } = renderComposer({
      history: [{ text: "look @src/a.ts", mentions: ["src/a.ts"] }],
    })
    press(textarea, "ArrowUp")
    expect(textarea.value).toBe("look @src/a.ts")
    await waitFor(() => expect(container.querySelector(".mention-chip")).not.toBeNull())
    expect(container.querySelector(".mention-chip")!.textContent).toContain("src/a.ts")
  })

  it("re-sends a recalled prompt with its file mentions attached", async () => {
    const onSend = vi.fn()
    const { textarea } = renderComposer({
      onSend,
      history: [{ text: "look @src/a.ts", mentions: ["src/a.ts"] }],
    })
    press(textarea, "ArrowUp")
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0]![0]).toBe("look @src/a.ts")
    expect(onSend.mock.calls[0]![1]).toEqual(["src/a.ts"])
  })
})

describe("PromptBox prompt history — position resets", () => {
  it("drops the browse position when the conversation changes", () => {
    const { rerender } = render(
      <PromptBox
        busy={false}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        history={HISTORY}
        activeConversationID="conv_a"
      />,
    )
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    press(textarea, "ArrowUp")
    expect(textarea.value).toBe("third prompt")

    rerender(
      <PromptBox
        busy={false}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        history={[{ text: "other conversation" }]}
        activeConversationID="conv_b"
      />,
    )
    // Not index 1 of the old list — the position restarted with the new one.
    press(textarea, "ArrowUp")
    expect(textarea.value).toBe("other conversation")
  })

  it("drops the browse position when the host injects text", () => {
    const { rerender } = render(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} history={HISTORY} inject={{ text: "", nonce: 0 }} />,
    )
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    press(textarea, "ArrowUp")
    expect(textarea.value).toBe("third prompt")

    rerender(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} history={HISTORY} inject={{ text: "restored by /undo", nonce: 1 }} />,
    )
    expect(textarea.value).toBe("restored by /undo")
    // Down must not resurrect the pre-recall draft over the injected text.
    press(textarea, "ArrowDown")
    expect(textarea.value).toBe("restored by /undo")
  })
})
