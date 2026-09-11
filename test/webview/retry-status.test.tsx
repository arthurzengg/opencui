import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import { MessageView } from "../../webview/src/components/MessageView"
import type { Message } from "../../webview/src/hooks/useChatState"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const pending = { id: "a1", role: "assistant", blocks: [], pending: true } as unknown as Message

describe("MessageView retry status (#611)", () => {
  it("replaces the thinking indicator with the retry line and a live countdown", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"))
    const next = Date.now() + 12_000
    const { container } = render(
      <MessageView
        message={pending}
        processOpen={false}
        processOnly={false}
        retry={{ attempt: 2, message: "Provider is overloaded", next }}
      />,
    )
    expect(container.querySelector(".thinking-dots")).toBeNull()
    expect(screen.getByRole("status").textContent).toBe(
      "Retrying (attempt 2): Provider is overloaded · next try in 12s",
    )
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.getByRole("status").textContent).toContain("next try in 9s")
    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    expect(screen.getByRole("status").textContent).toBe("Retrying (attempt 2): Provider is overloaded")
  })

  it("renders the action and opens its link through onOpenLink", () => {
    const onOpenLink = vi.fn()
    render(
      <MessageView
        message={pending}
        processOpen={false}
        processOnly={false}
        onOpenLink={onOpenLink}
        retry={{
          attempt: 1,
          message: "Usage limit reached.",
          next: 0,
          action: {
            title: "Go limit reached",
            message: "It will reset in 2 hours.",
            label: "open settings",
            link: "https://opencode.ai/workspace/w/go",
          },
        }}
      />,
    )
    expect(screen.getByText("Go limit reached.")).toBeInTheDocument()
    expect(screen.getByText(/It will reset in 2 hours/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("link", { name: "open settings" }))
    expect(onOpenLink).toHaveBeenCalledWith("https://opencode.ai/workspace/w/go")
  })

  it("keeps the thinking indicator when there is no retry", () => {
    const { container } = render(<MessageView message={pending} processOpen={false} processOnly={false} />)
    expect(container.querySelector(".thinking-dots")).not.toBeNull()
    expect(container.querySelector(".retry-status")).toBeNull()
  })

  it("renders nothing for a retry on a settled message", () => {
    const settled = { ...pending, pending: false } as Message
    const { container } = render(
      <MessageView message={settled} processOpen={false} processOnly={false} retry={{ attempt: 1, message: "x", next: 0 }} />,
    )
    expect(container.querySelector(".retry-status")).toBeNull()
  })
})
