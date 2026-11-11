import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PermissionDialog } from "../../webview/src/components/PermissionDialog"

afterEach(cleanup)

describe("PermissionDialog", () => {
  it("renders the title and the pattern", () => {
    const { container } = render(<PermissionDialog id="p1" title="Run a shell command" pattern="rm -rf dist" onReply={() => {}} />)
    expect(screen.getByRole("group", { name: "Permission request" })).toBeInTheDocument()
    expect(screen.getByText("Run a shell command")).toBeInTheDocument()
    expect(container.querySelector(".permission-pattern")?.textContent).toBe("rm -rf dist")
  })

  it("joins array patterns with a comma", () => {
    const { container } = render(<PermissionDialog id="p1" title="Edit files" pattern={["src/**", "test/**"]} onReply={() => {}} />)
    expect(container.querySelector(".permission-pattern")?.textContent).toBe("src/**, test/**")
  })

  it("boxes each word of the pattern so a line never breaks after a hyphen (#750)", () => {
    const { container } = render(<PermissionDialog id="p1" title="Run a command" pattern="git log --all -- src" onReply={() => {}} />)
    const tokens = Array.from(container.querySelectorAll(".permission-token"), (el) => el.textContent)
    expect(tokens).toEqual(["git", "log", "--all", "--", "src"])
  })

  it("omits the pattern element when none is given", () => {
    const { container } = render(<PermissionDialog id="p1" title="Do a thing" onReply={() => {}} />)
    expect(container.querySelector(".permission-pattern")).toBeNull()
  })

  it("names the patterns an Allow always answer would save (#619)", () => {
    render(
      <PermissionDialog id="p1" title="Run a command" pattern={["git status"]} always={["git *"]} onReply={() => {}} />,
    )
    expect(screen.getByRole("button", { name: "Allow always" })).toHaveAttribute("title", "Saves a rule for: git *")
  })

  it("shows the rule beside Allow always, and nothing when there is none (#750)", () => {
    const { container, rerender } = render(
      <PermissionDialog id="p1" title="Run a command" pattern={["git status"]} always={["git *"]} onReply={() => {}} />,
    )
    expect(container.querySelector(".permission-option-detail")?.textContent).toBe("git *")
    rerender(<PermissionDialog id="p1" title="Run a command" pattern={["git status"]} onReply={() => {}} />)
    expect(container.querySelector(".permission-option-detail")).toBeNull()
  })

  it("lists the narrowest grant first and fills only that one (#750)", () => {
    render(<PermissionDialog id="p1" title="Run a command" always={["git *"]} onReply={() => {}} />)
    const buttons = screen.getAllByRole("button")
    expect(buttons.map((b) => b.getAttribute("title") ? "Allow always" : b.textContent)).toEqual(["Allow once", "Allow always", "Reject"])
    expect(buttons.map((b) => b.classList.contains("is-primary"))).toEqual([true, false, false])
  })

  it("has no tooltip on Allow always when the request names nothing to save", () => {
    render(<PermissionDialog id="p1" title="Run a command" onReply={() => {}} />)
    expect(screen.getByRole("button", { name: "Allow always" })).not.toHaveAttribute("title")
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
