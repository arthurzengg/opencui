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

// Collapsed clip containers keep their body mounted (the fold animation needs
// content to clip), and clipped-but-mounted text still rides along in a
// select-copy of the transcript — a reasoning model's full thinking leaked
// into the clipboard, glued to the answer (#575). Only `visibility: hidden`
// excludes text from selection (opacity: 0 does not); the delayed flip keeps
// the content visible while the fold animation plays.
describe("collapsed panels are excluded from selection copy (#575)", () => {
  it("collapsed process bodies are visibility-hidden, delayed past the fold", () => {
    const collapsed = ruleBody(".process-body-clip")
    expect(collapsed).toMatch(/visibility:\s*hidden/)
    expect(collapsed).toMatch(/visibility 0s 0\.18s/)
  })

  it("open process bodies reveal instantly", () => {
    const open = ruleBody(".process.is-open .process-body-clip")
    expect(open).toMatch(/visibility:\s*visible/)
    expect(open).toMatch(/visibility 0s(?!\s+0)/)
  })

  it("the review panel's collapsed body gets the same guard", () => {
    const collapsed = ruleBody(".review-panel.is-collapsed .review-body-clip")
    expect(collapsed).toMatch(/visibility:\s*hidden/)
    expect(collapsed).toMatch(/visibility 0s 0\.2s/)
    const open = ruleBody(".review-body-clip")
    expect(open).toMatch(/visibility:\s*visible/)
  })
})
