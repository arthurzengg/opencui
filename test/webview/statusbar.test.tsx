import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StatusBar } from "../../webview/src/components/StatusBar"

beforeEach(() => {
  cleanup()
})
afterEach(cleanup)

const baseProps = {
  connected: true,
  selection: {},
  conversations: [],
  activeConversationID: undefined as string | undefined,
  onSelectAgent: vi.fn(),
  onSelectModel: vi.fn(),
  onCreateConversation: vi.fn(),
  onOpenConversation: vi.fn(),
  onRenameConversation: vi.fn(),
  onDeleteConversation: vi.fn(),
}

describe("StatusBar", () => {
  it("renders the model and agent labels and values", () => {
    render(
      <StatusBar
        {...baseProps}
        selection={{ model: "claude-opus-4-7", agent: "code-reviewer" }}
      />,
    )
    expect(screen.getByText("Model")).toBeInTheDocument()
    expect(screen.getByText("Opus 4.7")).toBeInTheDocument()
    expect(screen.getByText("Agent")).toBeInTheDocument()
    expect(screen.getByText("Code Reviewer")).toBeInTheDocument()
  })

  it("falls back to 'default' when selection is empty", () => {
    render(<StatusBar {...baseProps} />)
    expect(screen.getAllByText("default").length).toBeGreaterThanOrEqual(1)
  })

  it("hides connecting text when connected", () => {
    render(<StatusBar {...baseProps} connected={true} />)
    expect(screen.queryByText("connecting…")).not.toBeInTheDocument()
  })

  it("shows 'connecting…' when not connected", () => {
    render(<StatusBar {...baseProps} connected={false} />)
    expect(screen.getByText("connecting…")).toBeInTheDocument()
  })

  it("shows error text when error is set", () => {
    render(<StatusBar {...baseProps} connected={false} error="boom" />)
    expect(screen.getByText(/error · boom/)).toBeInTheDocument()
  })

  it("opens the selector popover on trigger click", async () => {
    const user = userEvent.setup()
    render(<StatusBar {...baseProps} selection={{ model: "claude-opus-4-7" }} />)
    const trigger = screen.getByRole("button", { name: /change agent and model/i })
    await user.click(trigger)
    // Popover rows visible
    expect(screen.getAllByRole("menuitem").length).toBe(2)
  })

  it("invokes onSelectModel when clicking the Model row in popover", async () => {
    const user = userEvent.setup()
    const onSelectModel = vi.fn()
    render(<StatusBar {...baseProps} onSelectModel={onSelectModel} />)
    await user.click(screen.getByRole("button", { name: /change agent and model/i }))
    const items = screen.getAllByRole("menuitem")
    await user.click(items[0]!) // Model row first
    expect(onSelectModel).toHaveBeenCalledOnce()
  })

  it("invokes onSelectAgent when clicking the Agent row in popover", async () => {
    const user = userEvent.setup()
    const onSelectAgent = vi.fn()
    render(<StatusBar {...baseProps} onSelectAgent={onSelectAgent} />)
    await user.click(screen.getByRole("button", { name: /change agent and model/i }))
    const items = screen.getAllByRole("menuitem")
    await user.click(items[1]!)
    expect(onSelectAgent).toHaveBeenCalledOnce()
  })

  it("renders the New chat icon button and fires onCreateConversation", async () => {
    const user = userEvent.setup()
    const onCreateConversation = vi.fn()
    render(<StatusBar {...baseProps} onCreateConversation={onCreateConversation} />)
    await user.click(screen.getByRole("button", { name: /new chat/i }))
    expect(onCreateConversation).toHaveBeenCalledOnce()
  })

  it("renders the History icon-only button", () => {
    render(<StatusBar {...baseProps} />)
    expect(screen.getByRole("button", { name: /chat history/i })).toBeInTheDocument()
  })
})

describe("StatusBar: history popover", () => {
  const conversations = [
    { id: "c1", title: "First chat", updatedAt: Date.now() - 60_000 },
    { id: "c2", title: "Second chat", updatedAt: Date.now() - 60 * 60_000 },
    { id: "c3", title: "Third chat", updatedAt: Date.now() - 24 * 60 * 60_000 },
  ]

  it("opens history popover and lists conversations", async () => {
    const user = userEvent.setup()
    render(<StatusBar {...baseProps} conversations={conversations} activeConversationID="c1" />)
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    expect(screen.getByText("First chat")).toBeInTheDocument()
    expect(screen.getByText("Second chat")).toBeInTheDocument()
    expect(screen.getByText("Third chat")).toBeInTheDocument()
  })

  it("shows New chat in popover and triggers onCreateConversation", async () => {
    const user = userEvent.setup()
    const onCreateConversation = vi.fn()
    render(<StatusBar {...baseProps} conversations={conversations} onCreateConversation={onCreateConversation} />)
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    await user.click(screen.getByText("New chat"))
    expect(onCreateConversation).toHaveBeenCalled()
  })

  it("hides search input below 5 conversations", async () => {
    const user = userEvent.setup()
    render(<StatusBar {...baseProps} conversations={conversations.slice(0, 3)} />)
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    expect(screen.queryByPlaceholderText(/search chats/i)).not.toBeInTheDocument()
  })

  it("shows search input at 5+ conversations", async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      title: `chat ${i}`,
      updatedAt: Date.now(),
    }))
    render(<StatusBar {...baseProps} conversations={many} />)
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    expect(screen.getByPlaceholderText(/search chats/i)).toBeInTheDocument()
  })

  it("filters conversations by search input", async () => {
    const user = userEvent.setup()
    const many = [
      { id: "a", title: "alpha bug", updatedAt: Date.now() },
      { id: "b", title: "beta feature", updatedAt: Date.now() },
      { id: "c", title: "alpha test", updatedAt: Date.now() },
      { id: "d", title: "gamma", updatedAt: Date.now() },
      { id: "e", title: "delta", updatedAt: Date.now() },
    ]
    render(<StatusBar {...baseProps} conversations={many} />)
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    const search = screen.getByPlaceholderText(/search chats/i)
    await user.type(search, "alpha")
    expect(screen.getByText("alpha bug")).toBeInTheDocument()
    expect(screen.getByText("alpha test")).toBeInTheDocument()
    expect(screen.queryByText("beta feature")).not.toBeInTheDocument()
    expect(screen.queryByText("gamma")).not.toBeInTheDocument()
  })

  it("shows empty state when search has no matches", async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      title: `chat ${i}`,
      updatedAt: Date.now(),
    }))
    render(<StatusBar {...baseProps} conversations={many} />)
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    await user.type(screen.getByPlaceholderText(/search chats/i), "nomatch")
    expect(screen.getByText(/No chats match/)).toBeInTheDocument()
  })

  it("requires two clicks on Delete (two-click confirmation)", async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    render(
      <StatusBar
        {...baseProps}
        conversations={conversations}
        onDeleteConversation={onDelete}
      />,
    )
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    const deleteButtons = screen.getAllByRole("button", { name: /^Delete$/i })
    await user.click(deleteButtons[0]!)
    expect(onDelete).not.toHaveBeenCalled()
    // Button should now read "Confirm"
    expect(screen.getByRole("button", { name: /^Confirm$/i })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /^Confirm$/i }))
    expect(onDelete).toHaveBeenCalledWith("c1")
  })

  it("opens a conversation when its row is clicked", async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(
      <StatusBar
        {...baseProps}
        conversations={conversations}
        onOpenConversation={onOpen}
      />,
    )
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    // history-open buttons carry the conversation title
    await user.click(screen.getByText("Second chat"))
    expect(onOpen).toHaveBeenCalledWith("c2")
  })

  it("renames a conversation via the inline editor", async () => {
    const user = userEvent.setup()
    const onRename = vi.fn()
    render(
      <StatusBar
        {...baseProps}
        conversations={conversations}
        onRenameConversation={onRename}
      />,
    )
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    await user.click(screen.getAllByRole("button", { name: /^Rename$/ })[0]!)
    const input = screen.getByDisplayValue("First chat")
    await user.clear(input)
    await user.type(input, "renamed{Enter}")
    expect(onRename).toHaveBeenCalledWith("c1", "renamed")
  })
})
