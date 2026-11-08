import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const css = readFileSync(resolve(__dirname, "../../webview/src/styles.css"), "utf8")

function ruleBody(selector: string): string {
  let from = 0
  while (true) {
    const open = css.indexOf(`\n${selector} {`, from)
    if (open < 0) throw new Error(`rule not found: ${selector}`)
    if (css[open - 1] === ",") {
      from = open + 1
      continue
    }
    const close = css.indexOf("}", open)
    return css.slice(open, close)
  }
}

// The chip's breakdown is an overlay, not an inline expansion: hovering must
// never change the message height (#656).
describe("usage chip stylesheet", () => {
  it("renders the breakdown as an absolutely positioned overlay the pointer cannot reach", () => {
    const body = ruleBody(".msg-usage-popover")
    expect(body).toContain("position: absolute")
    expect(body).toContain("bottom: calc(100% + 6px)")
    expect(body).toContain("pointer-events: none")
  })

  it("anchors the overlay to the chip and reveals it on hover and keyboard focus", () => {
    expect(ruleBody(".msg-usage")).toContain("position: relative")
    expect(css).toContain(".msg-usage:hover .msg-usage-popover,\n.msg-usage:focus-visible .msg-usage-popover {")
  })

  it("keeps the chip row free of a forward fill, which would stack the overlay under the sticky bubble (#742)", () => {
    expect(ruleBody(".msg-usage-row")).not.toMatch(/animation:.*(both|forwards)/)
    expect(ruleBody(".msg-usage-popover.is-below")).toContain("top: calc(100% + 6px)")
  })

  it("lays the rows out as a label/value grid with right-aligned tabular values (#742)", () => {
    expect(ruleBody(".msg-usage-table")).toContain("display: grid")
    const value = ruleBody(".msg-usage-value")
    expect(value).toContain("justify-self: end")
    expect(value).toContain("font-variant-numeric: tabular-nums")
  })

  it("keeps the chip right-aligned in its own row", () => {
    const row = ruleBody(".msg-usage-row")
    expect(row).toContain("display: flex")
    expect(row).toContain("justify-content: flex-end")
  })
})
