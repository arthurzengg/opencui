import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const css = readFileSync(path.resolve(__dirname, "../../webview/src/styles.css"), "utf8")

/** Body of the first top-level rule whose selector list is exactly `selector`. */
function ruleBody(selector: string): string {
  const open = css.indexOf(`\n${selector} {`)
  if (open === -1) throw new Error(`rule not found: ${selector}`)
  const start = open + selector.length + 3
  const end = css.indexOf("\n}", start)
  return css.slice(start, end)
}

function backgroundOf(selector: string): string {
  const m = ruleBody(selector).match(/(?:^|\n)\s*background:\s*([^;]+);/)
  if (!m) throw new Error(`no background declaration on ${selector}`)
  return m[1].replace(/\s+/g, " ").trim()
}

// `input.background` is not opaque in every theme (#528: a light theme ships
// it as #0000000D). Anything that floats over the scrolling transcript must
// paint the composited surface, never the raw token, or the text underneath
// shows through.
const FLOATING_SURFACES = [
  ".msg.role-user",
  '.msg.role-user.is-editable[data-edit-phase="view"]:hover',
  '.msg.role-user:not([data-edit-phase="view"])',
  ".user-edit-layer",
  ".review-panel",
  ".promptbox--bottom",
  ".context-usage-ring::after",
]

describe("opaque input surfaces (#528)", () => {
  it("--surface-input layers the input color over the opaque panel ground", () => {
    const m = css.match(/--surface-input:\s*([^;]+);/)
    expect(m).not.toBeNull()
    const value = m![1].replace(/\s+/g, " ").trim()
    expect(value).toBe(
      "linear-gradient(0deg, var(--color-bg-input), var(--color-bg-input)), var(--color-bg-panel)",
    )
  })

  it.each(FLOATING_SURFACES)("%s paints --surface-input, not the raw input token", (selector) => {
    const background = backgroundOf(selector)
    expect(background).toContain("var(--surface-input)")
    // The surface must be the bottom layer: anything after it would be painted
    // beneath, and a bare token there would defeat the composite.
    expect(background.endsWith("var(--surface-input)")).toBe(true)
    const body = ruleBody(selector)
    expect(body).not.toMatch(/var\(--color-bg-input\)|var\(--vscode-input-background\)/)
    expect(body).not.toMatch(/background-color:/)
  })
})
