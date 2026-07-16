import { describe, it, expect, afterEach, vi } from "vitest"
import { render, renderHook, screen, cleanup, fireEvent, act } from "@testing-library/react"
import { MessageView } from "../../webview/src/components/MessageView"
import { Markdown } from "../../webview/src/components/Markdown"
import { useThrottledValue } from "../../webview/src/hooks/useThrottledValue"
import type { Message } from "../../webview/src/hooks/useChatState"

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
