import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fireEvent, render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { StatusBar, type HeaderPopoverID } from "../../webview/src/components/StatusBar"
import { MessageView } from "../../webview/src/components/MessageView"
import type { Message } from "../../webview/src/hooks/useChatState"

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
  onSelectVariant: vi.fn(),
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

  it("opens the selector popover on trigger click and shows Model, Effort, Agent rows", async () => {
    const user = userEvent.setup()
    render(<StatusBar {...baseProps} selection={{ model: "claude-opus-4-7" }} />)
    const trigger = screen.getByRole("button", { name: /change agent, model, and effort/i })
    await user.click(trigger)
    expect(screen.getAllByRole("menuitem")).toHaveLength(3)
  })

  it("invokes onSelectModel when clicking the Model row in popover", async () => {
    const user = userEvent.setup()
    const onSelectModel = vi.fn()
    render(<StatusBar {...baseProps} onSelectModel={onSelectModel} />)
    await user.click(screen.getByRole("button", { name: /change agent, model, and effort/i }))
    const items = screen.getAllByRole("menuitem")
    await user.click(items[0]!)
    expect(onSelectModel).toHaveBeenCalledOnce()
  })

  it("invokes onSelectVariant when clicking the Effort row in popover", async () => {
    const user = userEvent.setup()
    const onSelectVariant = vi.fn()
    render(<StatusBar {...baseProps} onSelectVariant={onSelectVariant} />)
    await user.click(screen.getByRole("button", { name: /change agent, model, and effort/i }))
    const items = screen.getAllByRole("menuitem")
    await user.click(items[1]!) // Order: Model, Effort, Agent
    expect(onSelectVariant).toHaveBeenCalledOnce()
  })

  it("invokes onSelectAgent when clicking the Agent row in popover", async () => {
    const user = userEvent.setup()
    const onSelectAgent = vi.fn()
    render(<StatusBar {...baseProps} onSelectAgent={onSelectAgent} />)
    await user.click(screen.getByRole("button", { name: /change agent, model, and effort/i }))
    const items = screen.getAllByRole("menuitem")
    await user.click(items[2]!)
    expect(onSelectAgent).toHaveBeenCalledOnce()
  })

  it("renders the variant text in the trigger when modelVariant is set", () => {
    render(
      <StatusBar
        {...baseProps}
        selection={{ model: "openai/gpt-5.5", modelVariant: "high" }}
      />,
    )
    expect(screen.getByText("high")).toBeInTheDocument()
  })

  it("Effort row shows 'default' when no variant is selected", async () => {
    const user = userEvent.setup()
    render(<StatusBar {...baseProps} selection={{ model: "openai/gpt-5.5" }} />)
    await user.click(screen.getByRole("button", { name: /change agent, model, and effort/i }))
    const items = screen.getAllByRole("menuitem")
    expect(items[1]!.textContent).toMatch(/default/i)
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

describe("AgentsMenu (StatusBar inline popover)", () => {
  const baseStatus = {
    running: 1,
    waiting: 0,
    error: 0,
    total: 1,
    tasks: [
      {
        id: "main:c:s",
        kind: "main" as const,
        title: "Explain this file",
        status: "running" as const,
        startedAt: Date.now() - 12_000,
        updatedAt: Date.now(),
      },
    ],
  }

  it("renders 'Agents' even when no agentsStatus has been sent yet", () => {
    render(<StatusBar {...baseProps} />)
    expect(screen.getByText("Agents")).toBeInTheDocument()
    expect(screen.getByText("Agents").className).toContain("is-idle")
  })

  it("renders 'Agents' with is-idle when total === 0", () => {
    render(
      <StatusBar
        {...baseProps}
        agentsStatus={{ running: 0, waiting: 0, error: 0, total: 0, tasks: [] }}
      />,
    )
    const pill = screen.getByText("Agents")
    expect(pill).toBeInTheDocument()
    expect(pill.className).toContain("is-idle")
    expect(pill.className).not.toContain("is-running")
  })

  it("opens an empty-state popover when there are no tasks", async () => {
    const user = userEvent.setup()
    render(<StatusBar {...baseProps} />)
    await user.click(screen.getByText("Agents"))
    expect(screen.getByText("No agents in this chat")).toBeInTheDocument()
  })

  it("waits until click to dismiss so outside targets can handle their own click first", async () => {
    const user = userEvent.setup()
    render(<StatusBar {...baseProps} />)
    await user.click(screen.getByText("Agents"))
    expect(screen.getByText("No agents in this chat")).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.getByText("No agents in this chat")).toBeInTheDocument()
    fireEvent.click(document.body)
    expect(screen.queryByText("No agents in this chat")).not.toBeInTheDocument()
  })

  it("switches directly between header popovers", async () => {
    const user = userEvent.setup()
    const conversations = [{ id: "c1", title: "First chat", updatedAt: Date.now() }]
    render(<StatusBar {...baseProps} conversations={conversations} />)
    await user.click(screen.getByText("Agents"))
    expect(screen.getByText("No agents in this chat")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    expect(screen.queryByText("No agents in this chat")).not.toBeInTheDocument()
    expect(screen.getByText("Chat history")).toBeInTheDocument()
  })

  it("closes the popover and enters edit mode when the pushed user bubble is clicked", async () => {
    const user = userEvent.setup()
    const message = {
      id: "u1",
      role: "user",
      backendID: "backend-u1",
      blocks: [{ type: "text", text: "Explain this file by using subagent" }],
    } as Message
    function Harness() {
      const [activePopover, setActivePopover] = useState<HeaderPopoverID | null>(null)
      return (
        <>
          <StatusBar
            {...baseProps}
            activePopover={activePopover}
            onActivePopoverChange={setActivePopover}
          />
          <MessageView
            message={message}
            processOpen={false}
            processOnly={false}
            onEditMessage={vi.fn()}
            onBeginEdit={() => setActivePopover(null)}
          />
        </>
      )
    }
    render(<Harness />)
    await user.click(screen.getByText("Agents"))
    expect(screen.getByText("No agents in this chat")).toBeInTheDocument()

    await user.click(screen.getByText("Explain this file by using subagent"))

    expect(screen.queryByText("No agents in this chat")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save & regenerate" })).toBeInTheDocument()
  })

  it("renders 'Agents' when a task is running in this chat", () => {
    render(<StatusBar {...baseProps} agentsStatus={baseStatus} />)
    expect(screen.getByText("Agents")).toBeInTheDocument()
  })

  it("applies is-running class so the breathing animation can trigger", () => {
    render(<StatusBar {...baseProps} agentsStatus={baseStatus} />)
    const pill = screen.getByText("Agents")
    expect(pill.className).toContain("agents-pill")
    expect(pill.className).toContain("is-running")
  })

  it("uses static is-error class when only error tasks remain", () => {
    render(
      <StatusBar
        {...baseProps}
        agentsStatus={{
          running: 0,
          waiting: 0,
          error: 1,
          total: 1,
          tasks: [
            {
              id: "main:c:s",
              kind: "main",
              title: "Failed",
              status: "error",
              error: "boom",
              startedAt: 0,
              updatedAt: 1000,
            },
          ],
        }}
      />,
    )
    const pill = screen.getByText("Agents")
    expect(pill.className).toContain("is-error")
    expect(pill.className).not.toContain("is-running")
  })

  it("opens an inline popover on click and lists tasks", async () => {
    const user = userEvent.setup()
    render(
      <StatusBar
        {...baseProps}
        agentsStatus={{
          ...baseStatus,
          running: 2,
          total: 2,
          tasks: [
            {
              id: "main:c:s",
              kind: "main",
              title: "Refactor module",
              status: "running",
              startedAt: Date.now() - 5_000,
              updatedAt: Date.now(),
            },
            {
              id: "subagent:s:c1",
              kind: "subagent",
              title: "Fix lint errors",
              status: "running",
              startedAt: Date.now() - 2_000,
              updatedAt: Date.now(),
            },
          ],
        }}
      />,
    )
    expect(screen.queryByText("Refactor module")).not.toBeInTheDocument()
    await user.click(screen.getByText("Agents"))
    expect(screen.getByText("Refactor module")).toBeInTheDocument()
    expect(screen.getByText("Fix lint errors")).toBeInTheDocument()
    expect(screen.getByText("Main")).toBeInTheDocument()
    expect(screen.getByText("Subagents")).toBeInTheDocument()
  })

  it("groups separators are omitted when only one kind is present", async () => {
    const user = userEvent.setup()
    render(<StatusBar {...baseProps} agentsStatus={baseStatus} />)
    await user.click(screen.getByText("Agents"))
    expect(screen.getByText("Main")).toBeInTheDocument()
    expect(screen.queryByText("Subagents")).not.toBeInTheDocument()
  })

  it("shows errored subagent rows alongside a running parent", async () => {
    const user = userEvent.setup()
    render(
      <StatusBar
        {...baseProps}
        agentsStatus={{
          running: 1,
          waiting: 0,
          error: 1,
          total: 2,
          tasks: [
            {
              id: "main:c:s",
              kind: "main",
              title: "Explain this file",
              status: "running",
              startedAt: Date.now() - 12_000,
              updatedAt: Date.now(),
            },
            {
              id: "subagent:s:c1",
              kind: "subagent",
              title: "Explore codebase patterns",
              status: "error",
              error: "search timed out",
              startedAt: Date.now() - 10_000,
              updatedAt: Date.now() - 5_000,
            },
          ],
        }}
      />,
    )
    await user.click(screen.getByText("Agents"))
    expect(screen.getByText("Explore codebase patterns")).toBeInTheDocument()
    expect(screen.getByText("Subagents")).toBeInTheDocument()
  })

  it("closes the popover when Escape is pressed", async () => {
    const user = userEvent.setup()
    render(<StatusBar {...baseProps} agentsStatus={baseStatus} />)
    await user.click(screen.getByText("Agents"))
    expect(screen.getByText("Explain this file")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.queryByText("Explain this file")).not.toBeInTheDocument()
  })

  it("shows a tooltip summarizing the counts", () => {
    render(
      <StatusBar
        {...baseProps}
        agentsStatus={{
          running: 2,
          waiting: 1,
          error: 0,
          total: 3,
          tasks: [],
        }}
      />,
    )
    const pill = screen.getByText("Agents")
    expect(pill.getAttribute("title")).toMatch(/2 agents running/)
    expect(pill.getAttribute("title")).toMatch(/1 waiting for input/)
    expect(pill.getAttribute("title")).toMatch(/Click to view/)
  })

  it("renders the subagent slug + prettified model on a subagent row", async () => {
    const user = userEvent.setup()
    render(
      <StatusBar
        {...baseProps}
        agentsStatus={{
          running: 1,
          waiting: 0,
          error: 0,
          total: 1,
          tasks: [
            {
              id: "subagent:child:ses_x",
              kind: "subagent",
              title: "Explore auth flow",
              status: "running",
              startedAt: Date.now() - 4_000,
              updatedAt: Date.now(),
              subagent: "explore",
              model: { providerID: "github-copilot", modelID: "claude-opus-4.5" },
            },
          ],
        }}
      />,
    )
    await user.click(screen.getByText("Agents"))
    // formatAgent("explore") → "Explore"; formatModel(...) → "Opus 4.5".
    // The detail string joins them with " · ".
    expect(screen.getByText(/Explore · Opus 4\.5/)).toBeInTheDocument()
  })

  it("prefixes a category label when the dispatch went through a category route", async () => {
    const user = userEvent.setup()
    render(
      <StatusBar
        {...baseProps}
        agentsStatus={{
          running: 1,
          waiting: 0,
          error: 0,
          total: 1,
          tasks: [
            {
              id: "subagent:child:ses_y",
              kind: "subagent",
              title: "Deep refactor",
              status: "running",
              startedAt: Date.now() - 1_000,
              updatedAt: Date.now(),
              subagent: "hephaestus",
              category: "deep",
              model: { providerID: "github-copilot", modelID: "gpt-5.5" },
            },
          ],
        }}
      />,
    )
    await user.click(screen.getByText("Agents"))
    expect(screen.getByText(/category: deep/)).toBeInTheDocument()
    expect(screen.getByText(/Hephaestus/)).toBeInTheDocument()
  })

  it("does not render the agent/model detail line when neither is set", async () => {
    const user = userEvent.setup()
    render(
      <StatusBar
        {...baseProps}
        agentsStatus={{
          running: 1,
          waiting: 0,
          error: 0,
          total: 1,
          tasks: [
            {
              id: "subagent:child:ses_z",
              kind: "subagent",
              title: "Mystery worker",
              status: "running",
              startedAt: Date.now() - 1_000,
              updatedAt: Date.now(),
            },
          ],
        }}
      />,
    )
    await user.click(screen.getByText("Agents"))
    expect(screen.getByText("Mystery worker")).toBeInTheDocument()
    expect(screen.queryByText(/category:/)).not.toBeInTheDocument()
  })

  it("renders the empty state once every task has settled (popover is not chat history)", async () => {
    const user = userEvent.setup()
    render(
      <StatusBar
        {...baseProps}
        // Host filters terminal states out of the wire, so a settled
        // conversation arrives as an empty tasks array — the popover
        // shows only what's currently active, never history.
        agentsStatus={{
          running: 0,
          waiting: 0,
          error: 0,
          total: 0,
          tasks: [],
        }}
      />,
    )
    const pill = screen.getByText("Agents")
    expect(pill.className).toContain("is-idle")
    await user.click(pill)
    expect(screen.getByText("No agents in this chat")).toBeInTheDocument()
  })

  it("freezes the elapsed time on error rows using updatedAt - startedAt", async () => {
    const user = userEvent.setup()
    render(
      <StatusBar
        {...baseProps}
        agentsStatus={{
          running: 0,
          waiting: 0,
          error: 1,
          total: 1,
          tasks: [
            {
              id: "subagent:child:ses_err",
              kind: "subagent",
              title: "Failed subagent",
              status: "error",
              error: "boom",
              startedAt: 1_000,
              updatedAt: 13_000, // 12s elapsed regardless of when the popover renders
            },
          ],
        }}
      />,
    )
    await user.click(screen.getByText("Agents"))
    // Meta line reads "error · boom · 12s" — the row freezes the
    // duration so opening the popover later still says "12s".
    expect(screen.getByText(/error · boom · 12s/)).toBeInTheDocument()
  })
})
