import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StatusBar } from "../../webview/src/components/StatusBar"

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

const rules = [
  { id: "r1", permission: "bash", pattern: "git *", createdAt: Date.now() - 60_000 },
  { id: "r2", permission: "edit", pattern: "*", createdAt: Date.now() - 3_600_000 },
]

describe("StatusBar saved permission rules (#619)", () => {
  it("shows no shield until a rule exists", () => {
    render(<StatusBar {...baseProps} permissionRules={[]} onRemovePermissionRule={vi.fn()} />)
    expect(screen.queryByRole("button", { name: /saved permission rules/i })).toBeNull()
  })

  it("lists each rule's permission and pattern, removes one, and removes all", async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    const onClear = vi.fn()
    render(
      <StatusBar
        {...baseProps}
        permissionRules={rules}
        onRemovePermissionRule={onRemove}
        onClearPermissionRules={onClear}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Saved permission rules (2)" }))
    expect(screen.getByRole("dialog", { name: "Saved permission rules" })).toBeInTheDocument()
    expect(screen.getByText("bash")).toBeInTheDocument()
    expect(screen.getByText("git *")).toBeInTheDocument()
    expect(screen.getByText("edit")).toBeInTheDocument()
    expect(screen.getByText("1m ago")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Remove rule bash git *" }))
    expect(onRemove).toHaveBeenCalledWith("r1")

    await user.click(screen.getByRole("button", { name: "Remove all" }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it("closes when the shield is clicked again", async () => {
    const user = userEvent.setup()
    render(<StatusBar {...baseProps} permissionRules={rules} onRemovePermissionRule={vi.fn()} />)
    const trigger = screen.getByRole("button", { name: "Saved permission rules (2)" })
    await user.click(trigger)
    expect(screen.getByRole("dialog", { name: "Saved permission rules" })).toBeInTheDocument()
    await user.click(trigger)
    expect(screen.queryByRole("dialog", { name: "Saved permission rules" })).toBeNull()
  })
})
