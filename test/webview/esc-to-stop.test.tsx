import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, renderHook, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEscapeToStop } from "../../webview/src/hooks/useEscapeToStop"
import { useDismissableMenu } from "../../webview/src/hooks/useDismissableMenu"
import { ImagePreviewModal } from "../../webview/src/components/ImagePreviewModal"
import { StatusBar } from "../../webview/src/components/StatusBar"

afterEach(cleanup)

function pressEscape(init: KeyboardEventInit & { keyCode?: number } = {}) {
  fireEvent.keyDown(document.body, { key: "Escape", ...init })
}

describe("useEscapeToStop", () => {
  it("calls stop on Escape while active", () => {
    const stop = vi.fn()
    renderHook(() => useEscapeToStop(true, stop))
    pressEscape()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("ignores keys other than Escape", () => {
    const stop = vi.fn()
    renderHook(() => useEscapeToStop(true, stop))
    fireEvent.keyDown(document.body, { key: "Enter" })
    fireEvent.keyDown(document.body, { key: "s" })
    expect(stop).not.toHaveBeenCalled()
  })

  it("does nothing while inactive (idle or already aborting)", () => {
    const stop = vi.fn()
    renderHook(() => useEscapeToStop(false, stop))
    pressEscape()
    expect(stop).not.toHaveBeenCalled()
  })

  it("skips an Escape already consumed by an earlier layer (document fires before window)", () => {
    const stop = vi.fn()
    renderHook(() => useEscapeToStop(true, stop))
    const consume = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault()
    }
    document.addEventListener("keydown", consume)
    try {
      pressEscape()
    } finally {
      document.removeEventListener("keydown", consume)
    }
    expect(stop).not.toHaveBeenCalled()
    pressEscape()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("ignores Escape during IME composition", () => {
    const stop = vi.fn()
    renderHook(() => useEscapeToStop(true, stop))
    pressEscape({ isComposing: true })
    pressEscape({ keyCode: 229 })
    expect(stop).not.toHaveBeenCalled()
  })

  it("deactivating removes the listener; reactivating restores it", () => {
    const stop = vi.fn()
    const { rerender } = renderHook(({ active }) => useEscapeToStop(active, stop), {
      initialProps: { active: true },
    })
    rerender({ active: false })
    pressEscape()
    expect(stop).not.toHaveBeenCalled()
    rerender({ active: true })
    pressEscape()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

describe("Escape layer precedence over stop", () => {
  it("image preview: first Esc closes the preview, next Esc stops", () => {
    const stop = vi.fn()
    const onClose = vi.fn()
    function Harness({ open }: { open: boolean }) {
      useEscapeToStop(true, stop)
      return (
        <ImagePreviewModal
          src={open ? { dataUrl: "data:image/png;base64,x", filename: "shot.png" } : null}
          onClose={onClose}
        />
      )
    }
    const { rerender } = render(<Harness open={true} />)
    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
    rerender(<Harness open={false} />)
    pressEscape()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("dismissable popover: first Esc closes the menu, next Esc stops", () => {
    const stop = vi.fn()
    const { result } = renderHook(() => {
      useEscapeToStop(true, stop)
      return useDismissableMenu()
    })
    act(() => result.current.setOpen(true))
    pressEscape()
    expect(result.current.open).toBe(false)
    expect(stop).not.toHaveBeenCalled()
    pressEscape()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("rename input: Esc cancels the rename without stopping the turn", async () => {
    const user = userEvent.setup()
    const stop = vi.fn()
    const onRename = vi.fn()
    function Harness() {
      useEscapeToStop(true, stop)
      return (
        <StatusBar
          connected={true}
          selection={{}}
          conversations={[{ id: "c1", title: "First chat", updatedAt: Date.now() }]}
          activeConversationID="c1"
          onSetAgent={vi.fn()}
          onSetModel={vi.fn()}
          onRefreshModels={vi.fn()}
          onCreateConversation={vi.fn()}
          onOpenConversation={vi.fn()}
          onRenameConversation={onRename}
          onDeleteConversation={vi.fn()}
        />
      )
    }
    render(<Harness />)
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    await user.click(screen.getByRole("button", { name: /^Rename$/ }))
    const input = screen.getByDisplayValue("First chat")
    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.queryByDisplayValue("First chat")).not.toBeInTheDocument()
    expect(onRename).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })
})
