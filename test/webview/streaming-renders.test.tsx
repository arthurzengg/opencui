import { describe, it, expect, afterEach, vi } from "vitest"
import { render, renderHook, screen, cleanup, fireEvent, act } from "@testing-library/react"
import { MessageView } from "../../webview/src/components/MessageView"
import { Markdown } from "../../webview/src/components/Markdown"
import { useThrottledValue } from "../../webview/src/hooks/useThrottledValue"
import type { Block, Message } from "../../webview/src/hooks/useChatState"

// react-markdown is installed only under webview/, so the spy is registered
// by file path: a bare specifier would resolve from the root and never match
// the component's import. `Markdown` is hook-free, so wrapping the call
// counts parses exactly.
const parses = vi.hoisted(() => ({ count: 0 }))
vi.mock(new URL("../../webview/node_modules/react-markdown/index.js", import.meta.url).pathname, async (importOriginal) => {
  const mod = await importOriginal<{ default: (options: object) => unknown }>()
  return {
    ...mod,
    default: (options: object) => {
      parses.count++
      return mod.default(options)
    },
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("useThrottledValue", () => {
  it("emits the leading value, skips intermediates, and lands the trailing value", () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 50), {
      initialProps: { v: "a" },
    })
    expect(result.current).toBe("a")
    rerender({ v: "ab" })
    rerender({ v: "abc" })
    expect(result.current).toBe("a")
    act(() => {
      vi.advanceTimersByTime(60)
    })
    expect(result.current).toBe("abc")
  })

  it("passes through instantly when ms is 0", () => {
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 0), {
      initialProps: { v: "x" },
    })
    rerender({ v: "y" })
    expect(result.current).toBe("y")
  })
})

describe("Markdown streaming throttle", () => {
  it("samples streaming text at the throttle window and always lands the final text", () => {
    vi.useFakeTimers()
    const { container, rerender } = render(<Markdown text="hello" streaming />)
    expect(container.textContent).toContain("hello")
    rerender(<Markdown text="hello world" streaming />)
    // Mid-window: the parse still shows the sampled text.
    expect(container.textContent).not.toContain("world")
    act(() => {
      vi.advanceTimersByTime(60)
    })
    expect(container.textContent).toContain("world")
  })

  it("parses the sample once per throttle window, not once per frame (#597)", () => {
    vi.useFakeTimers()
    parses.count = 0
    const { rerender } = render(<Markdown text="hello" streaming />)
    expect(parses.count).toBe(1)
    for (const text of ["hello w", "hello wo", "hello wor", "hello world"]) {
      rerender(<Markdown text={text} streaming />)
    }
    // Four frames inside one window leave the sample unchanged, and the
    // memoized element keeps React from re-rendering react-markdown.
    expect(parses.count).toBe(1)
    act(() => {
      vi.advanceTimersByTime(60)
    })
    expect(parses.count).toBe(2)
  })

  it("renders settled (non-streaming) text updates immediately", () => {
    const { container, rerender } = render(<Markdown text="one" />)
    rerender(<Markdown text="two" />)
    expect(container.textContent).toContain("two")
  })
})

describe("ProcessPanel lazy body", () => {
  function toolMessage(): Message {
    return {
      id: "a1",
      role: "assistant",
      blocks: [
        { type: "tool", update: { callID: "c1", tool: "read", status: "completed", input: { filePath: "src/foo.ts" } } },
        { type: "text", text: "final answer text" },
      ],
    } as Message
  }

  it("mounts the collapsed body only after the first expand, then keeps it mounted", () => {
    const { container } = render(<MessageView message={toolMessage()} processOpen={false} processOnly={false} />)
    // The answer renders; the collapsed work panel's body is an empty shell.
    expect(screen.getByText("final answer text")).toBeInTheDocument()
    const body = container.querySelector(".process-body")!
    expect(body.childNodes.length).toBe(0)

    const head = container.querySelector<HTMLButtonElement>(".process-head")!
    fireEvent.click(head)
    expect(body.childNodes.length).toBeGreaterThan(0)

    // Collapsing keeps the content mounted so the fold animation has
    // something to clip.
    fireEvent.click(head)
    expect(container.querySelector(".process")!.classList.contains("is-open")).toBe(false)
    expect(body.childNodes.length).toBeGreaterThan(0)
  })
})

// The answer boundary moves on every tool call; the bubble must keep one
// tree shape across it or React remounts the panel and everything rendered
// inside it (#601).
describe("assistant bubble keeps its process panel across answer boundaries", () => {
  const tool = (callID: string): Block => ({
    type: "tool",
    update: { callID, tool: "read", status: "completed", input: { filePath: "src/foo.ts" } },
  } as Block)
  const text = (t: string): Block => ({ type: "text", text: t })
  const message = (blocks: Block[]): Message => ({ id: "a1", role: "assistant", blocks, pending: true } as Message)
  // A first-person line so textTitle() leaves it as a paragraph, not a title.
  const thinking = text("I need to read the file first.")

  it("the panel node and a paragraph inside it survive text, tool, text, tool", () => {
    const { container, rerender } = render(
      <MessageView message={message([thinking, tool("c1")])} processOpen processOnly={false} />,
    )
    const panel = container.querySelector(".process")!
    expect(panel.classList.contains("is-open")).toBe(true)
    const paragraph = panel.querySelector(".process-body p")!
    expect(paragraph.textContent).toBe("I need to read the file first.")

    // Answer text after the tool: the same panel, now the collapsed final one.
    rerender(
      <MessageView message={message([thinking, tool("c1"), text("Found it.")])} processOpen processOnly={false} />,
    )
    expect(container.querySelector(".process")).toBe(panel)
    expect(panel.querySelector(".process-body p")).toBe(paragraph)
    expect(panel.classList.contains("is-open")).toBe(false)
    expect(screen.getByText("Found it.")).toBeInTheDocument()

    // The next tool folds that text back into the live process: same panel,
    // open again, and the answer slot is empty.
    rerender(
      <MessageView
        message={message([thinking, tool("c1"), text("Found it."), tool("c2")])}
        processOpen
        processOnly={false}
      />,
    )
    expect(container.querySelector(".process")).toBe(panel)
    expect(panel.querySelector(".process-body p")).toBe(paragraph)
    expect(panel.classList.contains("is-open")).toBe(true)
    expect(container.querySelectorAll(".process")).toHaveLength(1)
  })

  it("a text-only reply still renders no panel", () => {
    const { container } = render(
      <MessageView message={message([text("Just an answer.")])} processOpen processOnly={false} />,
    )
    expect(container.querySelector(".process")).toBeNull()
    expect(screen.getByText("Just an answer.")).toBeInTheDocument()
  })
})
