import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CodeBlock } from "../../webview/src/components/CodeBlock"
import { vscode } from "../../webview/src/vscode"

// Stub clipboard for the Copy button
const writeText = vi.fn().mockResolvedValue(undefined)
beforeEach(() => {
  // jsdom's navigator.clipboard is a read-only getter; install via defineProperty.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  })
  writeText.mockClear()
  vi.spyOn(vscode, "post").mockImplementation(() => {})
})

afterEach(cleanup)

describe("CodeBlock", () => {
  it("highlights alias languages through the fine-grained grammar set", async () => {
    // "bash" resolves via the shellscript grammar's aliases — if that grammar
    // ever drops out of the curated list, codeToHtml throws and this renders
    // the plain fallback <pre> without the .shiki wrapper.
    const { container } = render(<CodeBlock code="ls -la" language="bash" />)
    await waitFor(() => expect(container.querySelector(".codeblock-body .shiki")).not.toBeNull(), {
      timeout: 5000,
    })
  })

  it("shows 'Apply' button label for non-shell languages", async () => {
    render(<CodeBlock code="const x = 1" language="typescript" />)
    expect(await screen.findByRole("button", { name: /^Apply$/ })).toBeInTheDocument()
  })

  it("shows 'Run' button label for shell languages", async () => {
    render(<CodeBlock code="npm start" language="bash" />)
    expect(await screen.findByRole("button", { name: /^Run$/ })).toBeInTheDocument()
  })

  it("normalizes 'sh' and 'shell' to bash for the Run label", async () => {
    const { unmount } = render(<CodeBlock code="echo" language="sh" />)
    expect(await screen.findByRole("button", { name: /^Run$/ })).toBeInTheDocument()
    unmount()
    render(<CodeBlock code="echo" language="shell" />)
    expect(await screen.findByRole("button", { name: /^Run$/ })).toBeInTheDocument()
  })

  it("posts { type: 'apply', code, language } when Apply/Run clicked", async () => {
    const user = userEvent.setup()
    render(<CodeBlock code="npm start" language="bash" />)
    await user.click(await screen.findByRole("button", { name: /^Run$/ }))
    expect(vscode.post).toHaveBeenCalledWith({
      type: "apply",
      code: "npm start",
      language: "bash",
    })
  })

  it("Copy button writes the code to the clipboard and updates label briefly", async () => {
    // Install our spy after userEvent is set up so it isn't overridden.
    const user = userEvent.setup()
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    render(<CodeBlock code="hello" language="typescript" />)
    const copy = await screen.findByRole("button", { name: /^Copy$/ })
    await user.click(copy)
    expect(writeText).toHaveBeenCalledWith("hello")
    expect(await screen.findByRole("button", { name: /^Copied$/ })).toBeInTheDocument()
  })

  it("displays the language label in the header", async () => {
    const { container } = render(<CodeBlock code="x" language="python" />)
    await screen.findByRole("button", { name: /^Apply$/ })
    expect(container.querySelector(".codeblock-lang")?.textContent).toBe("python")
  })

  it("unknown languages render as 'text'", async () => {
    const { container } = render(<CodeBlock code="x" language="some-fake-lang" />)
    await screen.findByRole("button", { name: /^Apply$/ })
    expect(container.querySelector(".codeblock-lang")?.textContent).toBe("text")
  })
})
