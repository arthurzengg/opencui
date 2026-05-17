import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { StatusIndicator } from "../../webview/src/components/StatusIndicator"

afterEach(cleanup)

describe("StatusIndicator", () => {
  it("renders dot only when no label is provided", () => {
    const { container } = render(<StatusIndicator kind="ok" />)
    expect(container.querySelector(".status-indicator-dot.ok")).not.toBeNull()
    expect(container.querySelector(".status-indicator-label")).toBeNull()
  })

  it("renders dot + label together when label is provided", () => {
    render(<StatusIndicator kind="warn" label="connecting…" />)
    expect(screen.getByText("connecting…")).toBeInTheDocument()
  })

  it.each([
    ["default", "default"],
    ["ok", "ok"],
    ["warn", "warn"],
    ["err", "err"],
    ["pending", "pending"],
  ] as const)("applies the %s kind class to the dot", (kind, expectedClass) => {
    const { container } = render(<StatusIndicator kind={kind} />)
    expect(container.querySelector(`.status-indicator-dot.${expectedClass}`)).not.toBeNull()
  })

  it("forwards the title attribute to the wrapper for native tooltips", () => {
    const { container } = render(
      <StatusIndicator kind="err" label="boom" title="error · boom" />,
    )
    const wrapper = container.querySelector(".status-indicator")
    expect(wrapper?.getAttribute("title")).toBe("error · boom")
  })

  it("co-locates dot + label so they share one inline line-box (regression: previously they were sibling flex children that misaligned vertically)", () => {
    const { container } = render(<StatusIndicator kind="warn" label="connecting…" />)
    const wrapper = container.querySelector(".status-indicator")
    const dot = container.querySelector(".status-indicator-dot")
    const label = container.querySelector(".status-indicator-label")
    expect(wrapper).not.toBeNull()
    // Both must be children of the same wrapper element — that's the structural
    // guarantee that prevents the bar's flex layout from centering them
    // independently and misaligning them.
    expect(dot?.parentElement).toBe(wrapper)
    expect(label?.parentElement).toBe(wrapper)
  })
})
