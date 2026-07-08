import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PermissionDialog } from "../../webview/src/components/PermissionDialog"

afterEach(cleanup)

describe("PermissionDialog", () => {
  it("renders the title and the pattern", () => {
    render(<PermissionDialog id="p1" title="Run a shell command" pattern="rm -rf dist" onReply={() => {}} />)
    expect(screen.getByText(/Permission requested/)).toBeInTheDocument()
    expect(screen.getByText("Run a shell command")).toBeInTheDocument()
    expect(screen.getByText("rm -rf dist")).toBeInTheDocument()
  })

  it("joins array patterns with a comma", () => {
    render(<PermissionDialog id="p1" title="Edit files" pattern={["src/**", "test/**"]} onReply={() => {}} />)
    expect(screen.getByText("src/**, test/**")).toBeInTheDocument()
  })

  it("omits the pattern element when none is given", () => {
    const { container } = render(<PermissionDialog id="p1" title="Do a thing" onReply={() => {}} />)
    expect(container.querySelector(".permission-pattern")).toBeNull()
  })

  it.each([
    ["Reject", "reject"],
    ["Allow once", "once"],
    ["Allow always", "always"],
  ] as const)("replies %s as %s", async (label, response) => {
    const onReply = vi.fn()
    render(<PermissionDialog id="p1" title="Run a command" onReply={onReply} />)
    await userEvent.click(screen.getByRole("button", { name: label }))
    expect(onReply).toHaveBeenCalledTimes(1)
    expect(onReply).toHaveBeenCalledWith("p1", response)
  })
})
