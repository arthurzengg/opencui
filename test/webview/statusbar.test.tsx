import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen, cleanup, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StatusBar } from "../../webview/src/components/StatusBar"
import { AgentActivity } from "../../webview/src/components/AgentActivity"
import { vscode } from "../../webview/src/vscode"
import type { AgentActivityResult } from "../../webview/src/hooks/useChatState"

beforeEach(() => {
  cleanup()
})
afterEach(cleanup)

const baseProps = {
  connected: true,
  selection: {},
  conversations: [],
  activeConversationID: undefined as string | undefined,
  onSetAgent: vi.fn(),
  onSetModel: vi.fn(),
  onSetProviderCollapsed: vi.fn(),
  onRefreshModels: vi.fn(),
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

  it("renders the new-chat button as a codicon-add glyph", () => {
    render(<StatusBar {...baseProps} />)
    const button = screen.getByRole("button", { name: "New chat" })
    expect(button.querySelector(".codicon-add")).toBeTruthy()
  })

  it("renders the history button as a codicon-history glyph", () => {
    render(<StatusBar {...baseProps} />)
    const button = screen.getByRole("button", { name: /Chat history/ })
    expect(button.querySelector(".codicon-history")).toBeTruthy()
  })

  it("falls back to 'default' when selection is empty", () => {
    render(<StatusBar {...baseProps} />)
    expect(screen.getAllByText("default").length).toBeGreaterThanOrEqual(1)
  })

  it("shows the healthy connected state as the ok dot, titled", () => {
    const { container } = render(<StatusBar {...baseProps} connected={true} />)
    expect(container.querySelector(".status-indicator-dot.ok")?.getAttribute("title")).toBe(
      "connected",
    )
  })

  it("shows the disconnected state as a dot only — never as text in the bar", () => {
    const { container } = render(<StatusBar {...baseProps} connected={false} />)
    expect(container.querySelector(".status-indicator-dot.warn")).not.toBeNull()
    expect(screen.queryByText("connecting…")).not.toBeInTheDocument()
  })

  it("shows a pending continuation as the pulsing dot, not as text", () => {
    const { container } = render(
      <StatusBar {...baseProps} connected={true} continuationPending={true} />,
    )
    expect(container.querySelector(".status-indicator-dot.pending")).not.toBeNull()
    expect(screen.queryByText("continuing…")).not.toBeInTheDocument()
  })

  it("keeps the error message reachable in the tooltip once the label is gone", () => {
    const { container } = render(<StatusBar {...baseProps} connected={false} error="boom" />)
    expect(container.querySelector(".status-indicator-dot.err")?.getAttribute("title")).toBe(
      "error · boom",
    )
    expect(screen.queryByText(/error · boom/)).not.toBeInTheDocument()
  })

  it("opens the in-panel model picker on trigger click (no QuickPick handoff)", async () => {
    const user = userEvent.setup()
    const onRefreshModels = vi.fn()
    render(
      <StatusBar
        {...baseProps}
        selection={{ model: "anthropic/claude-opus-4-7" }}
        modelCatalog={{
          models: [
            { providerID: "anthropic", modelID: "claude-opus-4-7", providerName: "Anthropic", variants: [] },
          ],
          recents: [],
        }}
        onRefreshModels={onRefreshModels}
      />,
    )
    const trigger = screen.getByRole("button", { name: /change agent, model, and effort/i })
    await user.click(trigger)
    expect(screen.getByRole("listbox", { name: "Models" })).toBeInTheDocument()
    // Opening asks the host for a fresh catalog (stale-while-revalidate).
    expect(onRefreshModels).toHaveBeenCalledOnce()
  })

  it("clicking an agent chip in the picker sets the agent and keeps the popover open", async () => {
    const user = userEvent.setup()
    const onSetAgent = vi.fn()
    render(
      <StatusBar
        {...baseProps}
        modelCatalog={{ models: [], recents: [], agents: [{ name: "build" }, { name: "plan" }] }}
        onSetAgent={onSetAgent}
      />,
    )
    await user.click(screen.getByRole("button", { name: /change agent, model, and effort/i }))
    await user.click(screen.getByRole("button", { name: "plan" }))
    expect(onSetAgent).toHaveBeenCalledWith("plan")
    // Picking in place replaced the old close-into-QuickPick footer handoff.
    expect(screen.getByRole("listbox", { name: "Models" })).toBeInTheDocument()
  })

  it("clicking a model row in the picker sets the model and keeps the popover open", async () => {
    const user = userEvent.setup()
    const onSetModel = vi.fn()
    render(
      <StatusBar
        {...baseProps}
        modelCatalog={{
          models: [
            { providerID: "openai", modelID: "gpt-5.5", providerName: "OpenAI", variants: ["low", "high"] },
          ],
          recents: [],
        }}
        onSetModel={onSetModel}
      />,
    )
    await user.click(screen.getByRole("button", { name: /change agent, model, and effort/i }))
    await user.click(screen.getByRole("option", { name: /gpt-5.5/ }))
    expect(onSetModel).toHaveBeenCalledWith("openai", "gpt-5.5", undefined)
    // The effort chips only exist for the current model, so the pick must not
    // close the popover before they can be tuned; Escape still closes it.
    expect(screen.getByRole("listbox", { name: "Models" })).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "Effort" })).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("listbox", { name: "Models" })).not.toBeInTheDocument()
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

  it("shows the current model's effort chips in the picker with 'default' active", async () => {
    const user = userEvent.setup()
    render(
      <StatusBar
        {...baseProps}
        selection={{ model: "openai/gpt-5.5" }}
        modelCatalog={{
          models: [
            { providerID: "openai", modelID: "gpt-5.5", providerName: "OpenAI", variants: ["low", "high"] },
          ],
          recents: [],
        }}
      />,
    )
    await user.click(screen.getByRole("button", { name: /change agent, model, and effort/i }))
    const defaultChip = screen.getByRole("button", { name: "default" })
    expect(defaultChip.className).toContain("is-active")
    expect(screen.getByRole("button", { name: "high" })).toBeInTheDocument()
  })

  it("trigger shows the Effort segment with 'default' even when no variant is set", () => {
    // Discoverability: the collapsed bar must always advertise Effort (like
    // Model/Agent), not hide it until a variant is picked.
    render(<StatusBar {...baseProps} selection={{ model: "openai/gpt-5.5" }} />)
    const trigger = screen.getByRole("button", { name: /change agent, model, and effort/i })
    expect(trigger.textContent).toMatch(/Effort/)
    expect(trigger.textContent).toMatch(/default/)
  })

  it("renders the New chat icon button and fires onCreateConversation", async () => {
    const user = userEvent.setup()
    const onCreateConversation = vi.fn()
    render(<StatusBar {...baseProps} onCreateConversation={onCreateConversation} />)
    await user.click(screen.getByRole("button", { name: /new chat/i }))
    expect(onCreateConversation).toHaveBeenCalledOnce()
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

  it("rename mode shows Save and Cancel; Save commits the rename", async () => {
    const user = userEvent.setup()
    const onRename = vi.fn()
    render(<StatusBar {...baseProps} conversations={conversations} onRenameConversation={onRename} />)
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    await user.click(screen.getAllByRole("button", { name: /^Rename$/ })[0]!)
    const input = screen.getByDisplayValue("First chat")
    await user.clear(input)
    await user.type(input, "saved title")
    await user.click(screen.getByRole("button", { name: /^Save$/ }))
    expect(onRename).toHaveBeenCalledWith("c1", "saved title")
    expect(screen.queryByDisplayValue("saved title")).not.toBeInTheDocument()
  })

  it("Cancel exits rename mode without committing", async () => {
    const user = userEvent.setup()
    const onRename = vi.fn()
    render(<StatusBar {...baseProps} conversations={conversations} onRenameConversation={onRename} />)
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    await user.click(screen.getAllByRole("button", { name: /^Rename$/ })[0]!)
    const input = screen.getByDisplayValue("First chat")
    await user.type(input, " edited")
    await user.click(screen.getByRole("button", { name: /^Cancel$/ }))
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByDisplayValue(/First chat/)).not.toBeInTheDocument()
    expect(screen.getByText("First chat")).toBeInTheDocument()
  })

  it("does not commit or exit edit mode on blur; Enter is the commit", async () => {
    const user = userEvent.setup()
    const onRename = vi.fn()
    render(<StatusBar {...baseProps} conversations={conversations} onRenameConversation={onRename} />)
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    await user.click(screen.getAllByRole("button", { name: /^Rename$/ })[0]!)
    const input = screen.getByDisplayValue("First chat")
    await user.clear(input)
    await user.type(input, "not committed yet")
    fireEvent.blur(input)
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue("not committed yet")).toBeInTheDocument()
  })

  it("cancels the rename on Escape without committing", async () => {
    const user = userEvent.setup()
    const onRename = vi.fn()
    render(<StatusBar {...baseProps} conversations={conversations} onRenameConversation={onRename} />)
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    await user.click(screen.getAllByRole("button", { name: /^Rename$/ })[0]!)
    const input = screen.getByDisplayValue("First chat")
    await user.type(input, " edited")
    await user.keyboard("{Escape}")
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByDisplayValue(/First chat/)).not.toBeInTheDocument()
    // Reopen: the row is out of edit mode with the original title intact.
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    expect(screen.getByText("First chat")).toBeInTheDocument()
  })

  it("stays in edit mode when Enter is pressed with an empty title", async () => {
    const user = userEvent.setup()
    const onRename = vi.fn()
    render(<StatusBar {...baseProps} conversations={conversations} onRenameConversation={onRename} />)
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    await user.click(screen.getAllByRole("button", { name: /^Rename$/ })[0]!)
    const input = screen.getByDisplayValue("First chat")
    await user.clear(input)
    await user.keyboard("{Enter}")
    expect(onRename).not.toHaveBeenCalled()
    expect(input).toBeInTheDocument()
  })
})

describe("AgentActivity", () => {
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

  it("stays hidden until there is active agent work", () => {
    render(<AgentActivity />)
    expect(screen.queryByRole("group", { name: "Agents for this response" })).not.toBeInTheDocument()
    cleanup()
    render(<AgentActivity status={{ running: 0, waiting: 0, error: 0, total: 0, tasks: [] }} />)
    expect(screen.queryByRole("group", { name: "Agents for this response" })).not.toBeInTheDocument()
  })

  it("renders one badge per task labeled with the role name, not the title", () => {
    render(
      <AgentActivity
        status={{
          running: 2,
          waiting: 0,
          error: 0,
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
              subagent: "explore",
            },
          ],
        }}
      />,
    )
    // formatAgent("explore") → "Explore"; main agent reads "Main".
    expect(screen.getByRole("button", { name: "Open Main activity" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Open Explore activity" })).toBeInTheDocument()
    expect(screen.queryByText("Refactor module")).not.toBeInTheDocument()
  })

  it("styles badges per status: running normal, waiting dimmed, error red", () => {
    render(
      <AgentActivity
        status={{
          running: 1,
          waiting: 1,
          error: 1,
          total: 3,
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
              id: "subagent:s:w1",
              kind: "subagent",
              title: "Waiting on input",
              status: "waiting",
              startedAt: Date.now() - 8_000,
              updatedAt: Date.now(),
              subagent: "librarian",
            },
            {
              id: "subagent:s:e1",
              kind: "subagent",
              title: "Failed worker",
              status: "error",
              error: "boom",
              startedAt: Date.now() - 10_000,
              updatedAt: Date.now() - 1_000,
            },
          ],
        }}
      />,
    )
    const runningBadge = screen.getByRole("button", { name: "Open Main activity" })
    const waitingBadge = screen.getByRole("button", { name: "Open Librarian activity" })
    const errorBadge = screen.getByRole("button", { name: "Open Agent activity" })
    expect(runningBadge.className).toContain("agents-badge-running")
    expect(waitingBadge.className).toContain("agents-badge-waiting")
    expect(waitingBadge.className).not.toContain("agents-badge-running")
    expect(errorBadge.className).toContain("agents-badge-error")
    expect(errorBadge.className).not.toContain("agents-badge-running")
  })

  it("breathes only the badge dot while running, on the shared clock (#621)", () => {
    const { container, rerender } = render(<AgentActivity status={baseStatus} />)
    const dot = container.querySelector(".agent-activity-dot") as HTMLElement
    expect(dot.className).toContain("live-breathe")
    expect(dot.style.animationDelay).toMatch(/^-?\d+ms$/)
    const badge = screen.getByRole("button", { name: "Open Main activity" }) as HTMLElement
    expect(badge.className).not.toContain("live-breathe")
    expect(badge.style.animationDelay).toBe("")

    rerender(
      <AgentActivity
        status={{
          running: 0,
          waiting: 1,
          error: 0,
          total: 1,
          tasks: [{ ...baseStatus.tasks[0]!, status: "waiting" }],
        }}
      />,
    )
    expect(dot.className).not.toContain("live-breathe")
    expect(dot.style.animationDelay).toBe("")
  })

  it("keeps the errored badge red even when nothing else is running", () => {
    render(
      <AgentActivity
        status={{
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
    const badge = screen.getByRole("button", { name: "Open Main activity" })
    expect(badge.className).toContain("agents-badge-error")
    expect(badge.className).not.toContain("agents-badge-running")
  })

  it("shows an errored subagent badge alongside a running parent", () => {
    render(
      <AgentActivity
        status={{
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
              subagent: "explore",
            },
          ],
        }}
      />,
    )
    expect(screen.getByRole("button", { name: "Open Main activity" }).className).toContain("agents-badge-running")
    const errored = screen.getByRole("button", { name: "Open Explore activity" })
    expect(errored.className).toContain("agents-badge-error")
    expect(errored.getAttribute("title")).toMatch(/search timed out/)
  })

  it("hides again once every task has settled", () => {
    render(
      <AgentActivity
        status={{
          running: 0,
          waiting: 0,
          error: 0,
          total: 0,
          tasks: [],
        }}
      />,
    )
    expect(screen.queryByRole("group", { name: "Agents for this response" })).not.toBeInTheDocument()
  })

  it("freezes the elapsed time on error badges using updatedAt - startedAt", () => {
    render(
      <AgentActivity
        status={{
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
              updatedAt: 13_000, // 12s elapsed regardless of when the badge renders
            },
          ],
        }}
      />,
    )
    const badge = screen.getByRole("button", { name: "Open Agent activity" })
    // The badge freezes the duration: updatedAt - startedAt stays "12s".
    expect(within(badge).getByText("12s")).toBeInTheDocument()
    expect(badge.getAttribute("title")).toMatch(/error · boom/)
  })

  it("opens the detail view from a badge: backlog + live stream + unsubscribe on close", async () => {
    const user = userEvent.setup()
    const postSpy = vi.spyOn(vscode, "post").mockImplementation(() => {})
    let resolveActivity: (result: AgentActivityResult) => void = () => {}
    const requestActivity = vi.fn(
      () =>
        new Promise<AgentActivityResult>((resolve) => {
          resolveActivity = resolve
        }),
    )
    render(
      <AgentActivity
        status={{
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
        requestActivity={requestActivity}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Open Explore activity" }))
    expect(requestActivity).toHaveBeenCalledWith("subagent:child:ses_x")
    expect(postSpy).toHaveBeenCalledWith({
      type: "agentActivitySubscribe",
      taskID: "subagent:child:ses_x",
    })
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument()
    expect(screen.getByText("explore")).toBeInTheDocument()
    expect(screen.getByText(/Opus 4\.5/)).toBeInTheDocument()
    expect(screen.getByText("running")).toBeInTheDocument()
    expect(screen.getByText("Loading activity…")).toBeInTheDocument()

    resolveActivity({ ok: true, messages: [{ role: "assistant", text: "Searching docs" }] })
    await screen.findByText("Searching docs")
    expect(screen.queryByText("Loading activity…")).not.toBeInTheDocument()

    // Live events append under the backlog.
    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: "agentActivityStream",
          taskID: "subagent:child:ses_x",
          event: { kind: "text", text: "live line one" },
        },
      }),
    )
    await screen.findByText("live line one")
    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: "agentActivityStream",
          taskID: "subagent:child:ses_x",
          event: { kind: "tool", tool: "bash", input: "bun test" },
        },
      }),
    )
    await screen.findByText("tool bash bun test")
    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: "agentActivityStream",
          taskID: "subagent:child:ses_x",
          event: { kind: "status", status: "waiting" },
        },
      }),
    )
    await screen.findByText("status waiting")
    // Events for other tasks (or malformed ones) never land in this feed.
    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: "agentActivityStream",
          taskID: "subagent:child:other",
          event: { kind: "text", text: "foreign line" },
        },
      }),
    )
    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: "agentActivityStream",
          taskID: "subagent:child:ses_x",
          event: { kind: "bogus" },
        },
      }),
    )
    expect(screen.queryByText("foreign line")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Back" }))
    expect(postSpy).toHaveBeenCalledWith({
      type: "agentActivityUnsubscribe",
      taskID: "subagent:child:ses_x",
    })
    expect(screen.getByRole("button", { name: "Open Explore activity" })).toBeInTheDocument()
  })

  it("shows the host error text when the backlog request fails", async () => {
    const user = userEvent.setup()
    vi.spyOn(vscode, "post").mockImplementation(() => {})
    const requestActivity = vi.fn(() =>
      Promise.resolve<AgentActivityResult>({ ok: false, error: "session gone" }),
    )
    render(
      <AgentActivity
        status={{
          running: 1,
          waiting: 0,
          error: 0,
          total: 1,
          tasks: [
            {
              id: "subagent:child:ses_e",
              kind: "subagent",
              title: "Broken worker",
              status: "running",
              startedAt: Date.now() - 1_000,
              updatedAt: Date.now(),
            },
          ],
        }}
        requestActivity={requestActivity}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Open Agent activity" }))
    await screen.findByText("session gone")
    expect(screen.queryByText("Loading activity…")).not.toBeInTheDocument()
  })

  it("flags a stale running task on both badge and detail", async () => {
    const user = userEvent.setup()
    render(
      <AgentActivity
        status={{
          running: 1,
          waiting: 0,
          error: 0,
          total: 1,
          tasks: [
            {
              id: "subagent:child:ses_s",
              kind: "subagent",
              title: "Stuck worker",
              status: "running",
              startedAt: Date.now() - 300_000,
              updatedAt: Date.now() - 120_000,
            },
          ],
        }}
      />,
    )
    const badge = screen.getByRole("button", { name: "Open Agent activity" })
    expect(badge.className).toContain("is-stuck")
    expect(badge.getAttribute("title")).toMatch(/no updates recently/)
    await user.click(badge)
    expect(screen.getByText(/no updates recently/)).toBeInTheDocument()
  })

  it("closes the detail when the task leaves agentsStatus", async () => {
    const user = userEvent.setup()
    const requestActivity = vi.fn(() => Promise.resolve<AgentActivityResult>({ ok: true }))
    const { rerender } = render(
      <AgentActivity
        status={{
          running: 1,
          waiting: 0,
          error: 0,
          total: 1,
          tasks: [
            {
              id: "subagent:child:ses_gone",
              kind: "subagent",
              title: "Gone worker",
              status: "running",
              startedAt: Date.now() - 1_000,
              updatedAt: Date.now(),
            },
          ],
        }}
        requestActivity={requestActivity}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Open Agent activity" }))
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument()
    rerender(<AgentActivity status={{ running: 0, waiting: 0, error: 0, total: 0, tasks: [] }} requestActivity={requestActivity} />)
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument()
    expect(screen.queryByRole("group", { name: "Agents for this response" })).not.toBeInTheDocument()
  })

  it("renders tool pills from the compacted backlog", async () => {
    const user = userEvent.setup()
    vi.spyOn(vscode, "post").mockImplementation(() => {})
    const requestActivity = vi.fn(() =>
      Promise.resolve<AgentActivityResult>({
        ok: true,
        messages: [{ role: "assistant", text: "Inspecting codebase", tools: ["grep", "read"] }],
      }),
    )
    render(
      <AgentActivity
        status={{
          running: 1,
          waiting: 0,
          error: 0,
          total: 1,
          tasks: [
            {
              id: "subagent:child:ses_tools",
              kind: "subagent",
              title: "Tool worker",
              status: "running",
              startedAt: Date.now() - 1_000,
              updatedAt: Date.now(),
            },
          ],
        }}
        requestActivity={requestActivity}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Open Agent activity" }))
    await screen.findByText("Inspecting codebase")
    expect(screen.getByText("tool grep")).toBeInTheDocument()
    expect(screen.getByText("tool read")).toBeInTheDocument()
  })

  it("coalesces consecutive live text stream chunks", async () => {
    const user = userEvent.setup()
    vi.spyOn(vscode, "post").mockImplementation(() => {})
    const requestActivity = vi.fn(() => Promise.resolve<AgentActivityResult>({ ok: true, messages: [] }))
    render(
      <AgentActivity
        status={{
          running: 1,
          waiting: 0,
          error: 0,
          total: 1,
          tasks: [
            {
              id: "subagent:child:ses_stream",
              kind: "subagent",
              title: "Stream worker",
              status: "running",
              startedAt: Date.now() - 1_000,
              updatedAt: Date.now(),
            },
          ],
        }}
        requestActivity={requestActivity}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Open Agent activity" }))
    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: "agentActivityStream",
          taskID: "subagent:child:ses_stream",
          event: { kind: "text", text: "Hello " },
        },
      }),
    )
    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: "agentActivityStream",
          taskID: "subagent:child:ses_stream",
          event: { kind: "text", text: "world!" },
        },
      }),
    )
    await screen.findByText("Hello world!")
  })

  it("closes the detail view on Escape key press", async () => {
    const user = userEvent.setup()
    const requestActivity = vi.fn(() => Promise.resolve<AgentActivityResult>({ ok: true }))
    render(
      <AgentActivity
        status={{
          running: 1,
          waiting: 0,
          error: 0,
          total: 1,
          tasks: [
            {
              id: "subagent:child:ses_esc",
              kind: "subagent",
              title: "Esc worker",
              status: "running",
              startedAt: Date.now() - 1_000,
              updatedAt: Date.now(),
            },
          ],
        }}
        requestActivity={requestActivity}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Open Agent activity" }))
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Open Agent activity" })).toBeInTheDocument()
  })

  it("preserves open detail view when task promotes to childSessionID identity", async () => {
    const user = userEvent.setup()
    const requestActivity = vi.fn(() => Promise.resolve<AgentActivityResult>({ ok: true }))
    const { rerender } = render(
      <AgentActivity
        status={{
          running: 1,
          waiting: 0,
          error: 0,
          total: 1,
          tasks: [
            {
              id: "subagent:dispatch:call_1",
              childSessionID: "ses_promoted",
              kind: "subagent",
              title: "Promoted worker",
              status: "running",
              startedAt: Date.now() - 1_000,
              updatedAt: Date.now(),
            },
          ],
        }}
        requestActivity={requestActivity}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Open Agent activity" }))
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument()

    // Host promotes row identity to subagent:child:ses_promoted
    rerender(
      <AgentActivity
        status={{
          running: 1,
          waiting: 0,
          error: 0,
          total: 1,
          tasks: [
            {
              id: "subagent:child:ses_promoted",
              childSessionID: "ses_promoted",
              kind: "subagent",
              title: "Promoted worker",
              status: "running",
              startedAt: Date.now() - 1_000,
              updatedAt: Date.now(),
            },
          ],
        }}
        requestActivity={requestActivity}
      />,
    )
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument()
  })

  it("displays toolCount on the badge when tools have been executed", () => {
    render(
      <AgentActivity
        status={{
          running: 1,
          waiting: 0,
          error: 0,
          total: 1,
          tasks: [
            {
              id: "subagent:child:ses_tools_count",
              kind: "subagent",
              title: "Worker with tools",
              status: "running",
              startedAt: Date.now() - 5_000,
              updatedAt: Date.now(),
              subagent: "explore",
              toolCount: 3,
            },
          ],
        }}
      />,
    )
    expect(screen.getByText("3 tools")).toBeInTheDocument()
    const badge = screen.getByRole("button", { name: "Open Explore activity" })
    expect(badge).toHaveAttribute("title", expect.stringContaining("3 tools"))
  })

  it("renders a clean note for the Main agent without calling requestActivity", async () => {
    const user = userEvent.setup()
    const requestActivity = vi.fn()
    render(
      <AgentActivity
        status={{
          running: 1,
          waiting: 0,
          error: 0,
          total: 1,
          tasks: [
            {
              id: "main:c:s",
              kind: "main",
              title: "Main turn",
              status: "running",
              startedAt: Date.now() - 2_000,
              updatedAt: Date.now(),
            },
          ],
        }}
        requestActivity={requestActivity}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Open Main activity" }))
    expect(screen.getByText("Main session activity is displayed in the chat transcript above")).toBeInTheDocument()
    expect(screen.queryByText("unknown task")).not.toBeInTheDocument()
    expect(screen.queryByText("Activity unavailable")).not.toBeInTheDocument()
    expect(requestActivity).not.toHaveBeenCalled()
  })

  it("formats live tool inputs cleanly ($ command, file path, grep query)", async () => {
    const user = userEvent.setup()
    vi.spyOn(vscode, "post").mockImplementation(() => {})
    const requestActivity = vi.fn(() => Promise.resolve<AgentActivityResult>({ ok: true, messages: [] }))
    render(
      <AgentActivity
        status={{
          running: 1,
          waiting: 0,
          error: 0,
          total: 1,
          tasks: [
            {
              id: "subagent:child:ses_live_tools",
              kind: "subagent",
              title: "Tool formatter",
              status: "running",
              startedAt: Date.now() - 1_000,
              updatedAt: Date.now(),
            },
          ],
        }}
        requestActivity={requestActivity}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Open Agent activity" }))
    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: "agentActivityStream",
          taskID: "subagent:child:ses_live_tools",
          event: { kind: "tool", tool: "bash", input: JSON.stringify({ command: "git status" }) },
        },
      }),
    )
    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: "agentActivityStream",
          taskID: "subagent:child:ses_live_tools",
          event: { kind: "tool", tool: "read", input: JSON.stringify({ filePath: "src/index.ts" }) },
        },
      }),
    )
    await screen.findByText("$ git status")
    expect(screen.getByText("read src/index.ts")).toBeInTheDocument()
  })
})

describe("StatusBar: unopened sessions in the history popover", () => {
  const conversations = [{ id: "c1", title: "Panel chat", updatedAt: Date.now() }]
  const external = [
    { id: "ses_tui", title: "TUI refactor", updatedAt: Date.now() - 60_000 },
    { id: "ses_web", title: "Web session", updatedAt: Date.now() - 120_000 },
  ]

  it("lists unopened sessions as ordinary rows that import on click", async () => {
    const user = userEvent.setup()
    const onImportSession = vi.fn()
    render(
      <StatusBar
        {...baseProps}
        conversations={conversations}
        externalSessions={external}
        onImportSession={onImportSession}
        onRefreshSessions={vi.fn()}
      />,
    )
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    expect(screen.queryByText("Also in this project")).toBeNull()
    const row = screen.getByText("TUI refactor").closest("button")!
    expect(row.closest(".history-item")?.classList.contains("is-external")).toBe(false)

    await user.click(row)
    expect(onImportSession).toHaveBeenCalledWith("ses_tui")
    // Importing closes the popover, like opening a local conversation does.
    expect(screen.queryByText("TUI refactor")).not.toBeInTheDocument()
  })

  it("re-fetches the session list when the popover opens", async () => {
    const user = userEvent.setup()
    const onRefreshSessions = vi.fn()
    render(
      <StatusBar
        {...baseProps}
        conversations={conversations}
        externalSessions={external}
        onImportSession={vi.fn()}
        onRefreshSessions={onRefreshSessions}
      />,
    )
    expect(onRefreshSessions).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    expect(onRefreshSessions).toHaveBeenCalledTimes(1)
  })

  it("search filters unopened rows like any other", async () => {
    const user = userEvent.setup()
    const manyLocal = [
      { id: "c1", title: "Panel chat one", updatedAt: Date.now() },
      { id: "c2", title: "Panel chat two", updatedAt: Date.now() },
      { id: "c3", title: "Panel chat three", updatedAt: Date.now() },
    ]
    render(
      <StatusBar
        {...baseProps}
        conversations={manyLocal}
        externalSessions={external}
        onImportSession={vi.fn()}
        onRefreshSessions={vi.fn()}
      />,
    )
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    // The search box keys off the combined local + external count.
    const search = screen.getByPlaceholderText("Search chats…")

    await user.type(search, "TUI")
    expect(screen.getByText("TUI refactor")).toBeInTheDocument()
    expect(screen.queryByText("Web session")).not.toBeInTheDocument()
    expect(screen.queryByText("Panel chat one")).not.toBeInTheDocument()

    await user.clear(search)
    await user.type(search, "Panel")
    expect(screen.queryByText("TUI refactor")).not.toBeInTheDocument()
    expect(screen.getByText("Panel chat one")).toBeInTheDocument()
  })

  it("forwards the search query to the session refresh, debounced (#617)", async () => {
    const user = userEvent.setup()
    const onRefreshSessions = vi.fn()
    const manyLocal = [
      { id: "c1", title: "Panel chat one", updatedAt: Date.now() },
      { id: "c2", title: "Panel chat two", updatedAt: Date.now() },
      { id: "c3", title: "Panel chat three", updatedAt: Date.now() },
    ]
    render(
      <StatusBar
        {...baseProps}
        conversations={manyLocal}
        externalSessions={external}
        onImportSession={vi.fn()}
        onRefreshSessions={onRefreshSessions}
      />,
    )
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    expect(onRefreshSessions).toHaveBeenCalledTimes(1)

    const search = screen.getByPlaceholderText("Search chats…")
    await user.type(search, "TUI")
    await waitFor(() => expect(onRefreshSessions).toHaveBeenLastCalledWith("TUI"))
    // One fetch for the whole word, not one per keystroke, and the opening
    // fetch carried no query.
    expect(onRefreshSessions.mock.calls.map((call) => call[0])).toEqual([undefined, "TUI"])

    await user.clear(search)
    await waitFor(() => expect(onRefreshSessions).toHaveBeenCalledTimes(3))
    expect(onRefreshSessions).toHaveBeenLastCalledWith(undefined)
  })

  it("shows only the saved conversations when there are no unopened sessions", async () => {
    const user = userEvent.setup()
    render(
      <StatusBar
        {...baseProps}
        conversations={conversations}
        externalSessions={[]}
        onImportSession={vi.fn()}
        onRefreshSessions={vi.fn()}
      />,
    )
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    expect(Array.from(document.querySelectorAll(".history-title")).map((el) => el.textContent)).toEqual(["Panel chat"])
  })
})

describe("StatusBar: one history list (#660)", () => {
  const conversations = [
    { id: "c1", title: "Panel chat", updatedAt: 3000 },
    { id: "c2", title: "Older panel chat", updatedAt: 1000 },
  ]
  const externalSessions = [{ id: "ses_tui", title: "TUI chat", updatedAt: 2000 }]
  const titles = () => Array.from(document.querySelectorAll(".history-title")).map((el) => el.textContent)

  it("interleaves unopened sessions with conversations by last activity, without a heading", async () => {
    const user = userEvent.setup()
    render(
      <StatusBar {...baseProps} conversations={conversations} externalSessions={externalSessions} onImportSession={vi.fn()} />,
    )
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    expect(titles()).toEqual(["Panel chat", "TUI chat", "Older panel chat"])
    expect(screen.queryByText("Also in this project")).toBeNull()
  })

  it("deletes an unopened session through onDeleteSession after the two-click confirm", async () => {
    const user = userEvent.setup()
    const onDeleteSession = vi.fn()
    const onDeleteConversation = vi.fn()
    render(
      <StatusBar
        {...baseProps}
        conversations={[]}
        externalSessions={externalSessions}
        onDeleteSession={onDeleteSession}
        onDeleteConversation={onDeleteConversation}
      />,
    )
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    await user.click(screen.getByRole("button", { name: /^Delete$/i }))
    expect(onDeleteSession).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: /^Confirm$/i }))
    expect(onDeleteSession).toHaveBeenCalledWith("ses_tui")
    expect(onDeleteConversation).not.toHaveBeenCalled()
  })

  it("gives every row the same actions so the date column lines up (#662)", async () => {
    const user = userEvent.setup()
    render(<StatusBar {...baseProps} conversations={conversations} externalSessions={externalSessions} />)
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    const rows = Array.from(document.querySelectorAll(".history-item"))
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(Array.from(row.querySelectorAll(".history-action")).map((b) => b.textContent)).toEqual(["Rename", "Delete"])
    }
  })

  it("renames an unopened session through onRenameSession", async () => {
    const user = userEvent.setup()
    const onRenameSession = vi.fn()
    const onRenameConversation = vi.fn()
    render(
      <StatusBar
        {...baseProps}
        conversations={[]}
        externalSessions={externalSessions}
        onRenameSession={onRenameSession}
        onRenameConversation={onRenameConversation}
      />,
    )
    await user.click(screen.getByRole("button", { name: /chat history/i }))
    await user.click(screen.getByRole("button", { name: /^Rename$/i }))
    const input = screen.getByDisplayValue("TUI chat")
    await user.clear(input)
    await user.type(input, "Renamed on the server{Enter}")
    expect(onRenameSession).toHaveBeenCalledWith("ses_tui", "Renamed on the server")
    expect(onRenameConversation).not.toHaveBeenCalled()
  })
})
