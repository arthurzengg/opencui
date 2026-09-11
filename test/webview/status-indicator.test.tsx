import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { StatusIndicator } from "../../webview/src/components/StatusIndicator"

afterEach(cleanup)

describe("StatusIndicator", () => {
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

  it("breathes on the shared clock only while pending (#621)", () => {
    const { container, rerender } = render(<StatusIndicator kind="pending" />)
    const dot = container.querySelector(".status-indicator-dot") as HTMLElement
    expect(dot.className).toContain("live-breathe")
    expect(dot.style.animationDelay).toMatch(/^-?\d+ms$/)
    rerender(<StatusIndicator kind="ok" />)
    expect(dot.className).not.toContain("live-breathe")
    expect(dot.style.animationDelay).toBe("")
  })

  it("renders the dot alone, with no status text", () => {
    const { container } = render(<StatusIndicator kind="warn" title="connecting…" />)
    expect(container.querySelector(".status-indicator-dot")).not.toBeNull()
    expect(container.textContent).toBe("")
  })

  it("puts the title on the dot itself — it is the only surface for the status text", () => {
    const { container } = render(<StatusIndicator kind="err" title="error · boom" />)
    const dot = container.querySelector(".status-indicator-dot")
    expect(dot?.getAttribute("title")).toBe("error · boom")
  })
})
