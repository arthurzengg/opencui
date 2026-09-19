import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const css = readFileSync(path.resolve(__dirname, "../../webview/src/styles.css"), "utf8")

/** Body of the first top-level rule whose selector list is exactly `selector`. */
function ruleBody(selector: string): string {
  const needle = `\n${selector} {`
  let from = 0
  for (;;) {
    const open = css.indexOf(needle, from)
    if (open === -1) throw new Error(`rule not found: ${selector}`)
    // A match preceded by a comma is the last line of a grouped selector list.
    if (css[open - 1] !== ",") {
      const start = open + needle.length
      return css.slice(start, css.indexOf("\n}", start))
    }
    from = open + 1
  }
}

describe("progressive blur under the bottom dock (#643)", () => {
  // A mask, filter, opacity, or clip-path on the wrapper makes it a backdrop
  // root, and the layers inside would then blur the wrapper's own empty
  // painting instead of the transcript. Nothing errors; the effect just goes.
  it("keeps the wrapper free of backdrop-root properties", () => {
    const body = ruleBody(".bottom-dock-glass")
    expect(body).not.toMatch(
      /\b(mask|mask-image|filter|backdrop-filter|opacity|clip-path|mix-blend-mode|isolation|will-change)\s*:/,
    )
  })

  it("blurs in two sibling layers whose masks ramp in from the top", () => {
    for (const selector of [".bottom-dock-glass::before", ".bottom-dock-glass::after"]) {
      const body = ruleBody(selector)
      expect(body).toMatch(/backdrop-filter:\s*blur\(/)
      expect(body).toMatch(/mask-image:\s*linear-gradient\(to bottom, transparent/)
    }
  })

  it("reserves the ramp in the transcript padding and subtracts it from the last-turn spacer", () => {
    expect(ruleBody(".messages")).toMatch(
      /padding:[^;]*var\(--bottom-dock-fade\)[^;]*var\(--bottom-dock-height, 0px\)/,
    )
    expect(ruleBody(".turn:last-child")).toMatch(/min-height:[^;]*- var\(--bottom-dock-fade\)/)
  })

  // The ramp ends at the dock's top edge. The composer's edge gap then holds a
  // fully blurred plateau before its box; a card leading the dock needs the
  // same gap or the ramp runs straight into its border (#645).
  it("gives a card that leads the dock the composer's edge gap above it", () => {
    const leading = [
      ".bottom-dock > .bottom-dock-glass + .permission",
      ".bottom-dock > .bottom-dock-glass + .question",
      ".bottom-dock > .bottom-dock-glass + .review-panel",
      ".bottom-dock > .bottom-dock-glass + .queued-messages",
    ].join(",\n")
    expect(ruleBody(leading)).toMatch(/margin-top:\s*var\(--composer-edge-gap\);/)
    expect(ruleBody(".bottom-composer")).toMatch(/padding:\s*var\(--composer-edge-gap\) 12px/)
  })

  it("stays inside the dock's stacking context so z-index -1 sits above the transcript", () => {
    expect(ruleBody(".bottom-dock-glass")).toMatch(/z-index:\s*-1;/)
    expect(ruleBody(".bottom-dock")).toMatch(/z-index:\s*var\(--z-overlay\);/)
  })
})
