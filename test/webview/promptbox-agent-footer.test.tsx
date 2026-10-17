import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, within, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PromptBox } from "../../webview/src/components/PromptBox"

afterEach(cleanup)

const AGENT_COMMANDS = [
  { name: "compact", description: "Compact", takesArguments: false },
  { name: "build", description: "Switch to the build agent", takesArguments: true, agentSwitch: true },
]

const CATALOG = {
  models: [
    { providerID: "anthropic", modelID: "claude", variants: ["low", "high"] },
  ],
  recents: [],
  agents: [{ name: "build" }, { name: "plan" }],
} as any

describe("PromptBox footer selectors + /agent", () => {
  it("renders separate Agent + Effort triggers bound to selection", () => {
    render(
      <PromptBox
        busy={false}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        commands={AGENT_COMMANDS}
        onRunCommand={vi.fn()}
        selection={{ agent: "plan", model: "anthropic/claude", modelVariant: "high" }}
        modelCatalog={CATALOG}
        onSetAgent={vi.fn()}
        onSetModel={vi.fn()}
      />,
    )
    expect(screen.getByRole("button", { name: /Change agent.*plan/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Change effort.*high/i })).toBeInTheDocument()
  })

  it("hides Effort when the current model has no variants", () => {
    render(
      <PromptBox
        busy={false}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        selection={{ model: "anthropic/claude" }}
        modelCatalog={{ models: [{ providerID: "anthropic", modelID: "claude", variants: [] }], recents: [], agents: [{ name: "build" }] } as any}
        onSetAgent={vi.fn()}
        onSetModel={vi.fn()}
      />,
    )
    expect(screen.queryByRole("button", { name: /Change effort/i })).toBeNull()
  })

  it("picking an agent in the footer calls onSetAgent", async () => {
    const user = userEvent.setup()
    const onSetAgent = vi.fn()
    render(
      <PromptBox
        busy={false}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        selection={{}}
        modelCatalog={CATALOG}
        onSetAgent={onSetAgent}
        onSetModel={vi.fn()}
      />,
    )
    await user.click(screen.getByRole("button", { name: /Change agent/i }))
    await user.click(screen.getByRole("option", { name: "build" }))
    expect(onSetAgent).toHaveBeenCalledWith("build")
  })

  it("typing /agent prompt switches + sends atomically via onRunCommand", async () => {
    const user = userEvent.setup()
    const onRunCommand = vi.fn()
    const onSetAgent = vi.fn()
    const onSend = vi.fn()
    render(
      <PromptBox
        busy={false}
        onSend={onSend}
        onAbort={vi.fn()}
        commands={AGENT_COMMANDS}
        onRunCommand={onRunCommand}
        selection={{}}
        modelCatalog={CATALOG}
        onSetAgent={onSetAgent}
        onSetModel={vi.fn()}
      />,
    )
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    // Type the full invocation directly to avoid picker Enter interception.
    await user.type(textarea, "/build fix the bug")
    await user.keyboard("{Enter}")
    expect(onRunCommand).toHaveBeenCalledWith("build", "fix the bug", undefined, undefined, undefined)
    expect(onSend).not.toHaveBeenCalled()
    expect(textarea.value).toBe("")
  })

  it("bare /agent only switches", async () => {
    const user = userEvent.setup()
    const onRunCommand = vi.fn()
    const onSetAgent = vi.fn()
    render(
      <PromptBox
        busy={false}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        commands={AGENT_COMMANDS}
        onRunCommand={onRunCommand}
        selection={{}}
        modelCatalog={CATALOG}
        onSetAgent={onSetAgent}
        onSetModel={vi.fn()}
      />,
    )
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.type(textarea, "/build")
    // Dismiss the picker first (it would insert "/build " on Enter); Escape closes it.
    await user.keyboard("{Escape}")
    await user.keyboard("{Enter}")
    expect(onSetAgent).toHaveBeenCalledWith("build")
    expect(onRunCommand).not.toHaveBeenCalled()
  })

  it("shows a loading state while the catalog never arrived", async () => {
    const user = userEvent.setup()
    render(
      <PromptBox
        busy={false}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        selection={{ agent: "plan", model: "anthropic/claude" }}
        modelCatalog={undefined}
        onSetAgent={vi.fn()}
        onSetModel={vi.fn()}
      />,
    )
    // Agent lists what it can (the default reset) plus an explicit loading row…
    await user.click(screen.getByRole("button", { name: /Change agent/i }))
    expect(screen.getByText("Loading agents…")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    // …and Effort renders disabled instead of vanishing (no row jump later).
    const effort = screen.getByRole("button", { name: /Loading effort/i })
    expect(effort).toBeDisabled()
  })

  it("lists /agent entries in the slash picker", async () => {
    const user = userEvent.setup()
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} commands={AGENT_COMMANDS} onRunCommand={vi.fn()} />)
    await user.type(screen.getByRole("textbox"), "/bui")
    const list = await screen.findByRole("listbox", { name: /Commands/i })
    expect(within(list).getByText("/build")).toBeInTheDocument()
  })
})
