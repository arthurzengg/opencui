import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { StatusBar } from "../../webview/src/components/StatusBar"
import { MessageView } from "../../webview/src/components/MessageView"
import type { Message } from "../../webview/src/hooks/useChatState"

afterEach(cleanup)

function userMessage(): Message {
  return {
    id: "u1",
    role: "user",
    blocks: [{ type: "text", text: "hello" }],
    backendID: "b_u1",
  }
}

describe("revert/restore smoke", () => {
  it("renders header undo/redo buttons and fires callbacks", () => {
    const onUndo = vi.fn()
    const onRedo = vi.fn()
    render(
      <StatusBar
        connected
        selection={{}}
        conversations={[]}
        onSetAgent={() => {}}
        onSetModel={() => {}}
        onSetProviderCollapsed={() => {}}
        onToggleModelFavorite={() => {}}
        onRefreshModels={() => {}}
        onCreateConversation={() => {}}
        onOpenConversation={() => {}}
        onRenameConversation={() => {}}
        onDeleteConversation={() => {}}
        canUndo
        onUndoLastTurn={onUndo}
        onRedoTurn={onRedo}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Revert last turn" }))
    fireEvent.click(screen.getByRole("button", { name: "Restore turn" }))
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(onRedo).toHaveBeenCalledTimes(1)
  })

  it("renders the per-message revert button and fires with the message id", () => {
    const onRevert = vi.fn()
    render(
      <MessageView
        message={userMessage()}
        processOpen={false}
        processOnly={false}
        onRevertMessage={onRevert}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Revert to this message" }))
    expect(onRevert).toHaveBeenCalledWith("u1")
  })

  it("hides the per-message revert button while busy", () => {
    render(
      <MessageView
        message={userMessage()}
        processOpen={false}
        processOnly={false}
        busy
        onRevertMessage={() => {}}
      />,
    )
    expect(screen.queryByRole("button", { name: "Revert to this message" })).toBeNull()
  })
})
