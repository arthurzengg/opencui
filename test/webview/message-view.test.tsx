import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MessageView } from "../../webview/src/components/MessageView"
import type { Message } from "../../webview/src/hooks/useChatState"

afterEach(cleanup)

function userMessage(text: string, opts: { id?: string; backendID?: string } = {}): Message {
  return {
    id: opts.id ?? "u1",
    role: "user",
    blocks: [{ type: "text", text }],
    backendID: opts.backendID,
  } as Message
}

function assistantMessage(text: string, opts: { id?: string; pending?: boolean } = {}): Message {
  return {
    id: opts.id ?? "a1",
    role: "assistant",
    blocks: text ? [{ type: "text", text }] : [],
    pending: opts.pending,
  } as Message
}

describe("MessageView (user role)", () => {
  it("renders the user message text", () => {
    render(
      <MessageView
        message={userMessage("hello world")}
        processOpen={false}
        processOnly={false}
      />,
    )
    expect(screen.getByText("hello world")).toBeInTheDocument()
  })

  it("renders edit hint icon when an onEditMessage handler is provided", () => {
    const { container } = render(
      <MessageView
        message={userMessage("hi", { backendID: "b1" })}
        processOpen={false}
        processOnly={false}
        onEditMessage={vi.fn()}
      />,
    )
    expect(container.querySelector(".user-edit-hint")).not.toBeNull()
  })

  it("opens edit mode when bubble is clicked (editable state)", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MessageView
        message={userMessage("hi", { backendID: "b1" })}
        processOpen={false}
        processOnly={false}
        onEditMessage={vi.fn()}
      />,
    )
    const bubble = container.querySelector(".msg.role-user") as HTMLElement
    await user.click(bubble)
    // Now in edit mode — textarea should appear
    expect(container.querySelector("textarea.user-edit-input")).not.toBeNull()
    expect(screen.getByText("Save & regenerate")).toBeInTheDocument()
  })

  it("does NOT enter edit mode while busy", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MessageView
        message={userMessage("hi", { backendID: "b1" })}
        processOpen={false}
        processOnly={false}
        busy={true}
        onEditMessage={vi.fn()}
      />,
    )
    const bubble = container.querySelector(".msg.role-user") as HTMLElement
    await user.click(bubble)
    expect(container.querySelector("textarea.user-edit-input")).toBeNull()
  })

  it("does NOT enter edit mode without backendID", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MessageView
        message={userMessage("hi")} // no backendID
        processOpen={false}
        processOnly={false}
        onEditMessage={vi.fn()}
      />,
    )
    const bubble = container.querySelector(".msg.role-user") as HTMLElement
    await user.click(bubble)
    expect(container.querySelector("textarea.user-edit-input")).toBeNull()
  })

  it("calls onEditMessage when Save & regenerate is clicked with a changed value", async () => {
    const user = userEvent.setup()
    const onEditMessage = vi.fn()
    const { container } = render(
      <MessageView
        message={userMessage("original", { id: "u-edit", backendID: "b1" })}
        processOpen={false}
        processOnly={false}
        onEditMessage={onEditMessage}
      />,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    await user.clear(textarea)
    await user.type(textarea, "updated text")
    await user.click(screen.getByText("Save & regenerate"))
    expect(onEditMessage).toHaveBeenCalledWith("u-edit", "updated text")
  })

  it("Save button is disabled when content is unchanged", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MessageView
        message={userMessage("same text", { backendID: "b1" })}
        processOpen={false}
        processOnly={false}
        onEditMessage={vi.fn()}
      />,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    const save = screen.getByText("Save & regenerate") as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it("Cancel returns to view mode without firing onEditMessage", async () => {
    const user = userEvent.setup()
    const onEditMessage = vi.fn()
    const { container } = render(
      <MessageView
        message={userMessage("hi", { backendID: "b1" })}
        processOpen={false}
        processOnly={false}
        onEditMessage={onEditMessage}
      />,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    expect(container.querySelector("textarea")).not.toBeNull()
    await user.click(screen.getByText("Cancel"))
    expect(container.querySelector("textarea")).toBeNull()
    expect(onEditMessage).not.toHaveBeenCalled()
  })

  it("Escape key in textarea cancels edit mode", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MessageView
        message={userMessage("hi", { backendID: "b1" })}
        processOpen={false}
        processOnly={false}
        onEditMessage={vi.fn()}
      />,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    textarea.focus()
    await user.keyboard("{Escape}")
    expect(container.querySelector("textarea")).toBeNull()
  })

  it("Cmd+Enter in textarea fires Save with the new content", async () => {
    const user = userEvent.setup()
    const onEditMessage = vi.fn()
    const { container } = render(
      <MessageView
        message={userMessage("orig", { id: "u-cmd", backendID: "b1" })}
        processOpen={false}
        processOnly={false}
        onEditMessage={onEditMessage}
      />,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    await user.clear(textarea)
    await user.type(textarea, "via shortcut")
    await user.keyboard("{Meta>}{Enter}{/Meta}")
    expect(onEditMessage).toHaveBeenCalledWith("u-cmd", "via shortcut")
  })

  it("renders the editor-context label when message has ref", () => {
    render(
      <MessageView
        message={{ ...userMessage("hi"), ref: { label: "src/foo.ts" } } as Message}
        processOpen={false}
        processOnly={false}
      />,
    )
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument()
  })
})

describe("MessageView (assistant role)", () => {
  it("renders thinking indicator when message is pending and has no blocks", () => {
    render(
      <MessageView
        message={assistantMessage("", { pending: true })}
        processOpen={false}
        processOnly={false}
      />,
    )
    expect(screen.getByText("thinking")).toBeInTheDocument()
  })

  it("renders error text when message has error", () => {
    const msg = { ...assistantMessage(""), error: "AI error happened" } as Message
    render(<MessageView message={msg} processOpen={false} processOnly={false} />)
    expect(screen.getByText("AI error happened")).toBeInTheDocument()
  })

  it("renders model + cost + token usage when present", () => {
    const msg = {
      ...assistantMessage("response"),
      usage: { model: "claude-opus-4-7", cost: 0.0025, tokens: { input: 100, output: 50, reasoning: 0 } },
    } as Message
    render(<MessageView message={msg} processOpen={false} processOnly={false} />)
    expect(screen.getByText("claude-opus-4-7")).toBeInTheDocument()
    expect(screen.getByText(/0\.0025/)).toBeInTheDocument()
    expect(screen.getByText(/150 tokens/)).toBeInTheDocument()
  })
})
