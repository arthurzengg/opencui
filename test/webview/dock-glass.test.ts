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

  // The gap between a docked card and the composer is the composer's own edge
  // gap and shows the glass. A seam-fill override or the old peek strip would
  // put a flat band back between the two surfaces (#647).
  it("leaves the gap under a docked card open to the glass", () => {
    expect(css).not.toMatch(/\.review-panel \+ \.bottom-composer/)
    expect(css).not.toMatch(/\.queued-messages \+ \.bottom-composer/)
    expect(css).not.toMatch(/\n\.review-panel::after \{/)
  })

  it("stays inside the dock's stacking context so z-index -1 sits above the transcript", () => {
    expect(ruleBody(".bottom-dock-glass")).toMatch(/z-index:\s*-1;/)
    expect(ruleBody(".bottom-dock")).toMatch(/z-index:\s*var\(--z-overlay\);/)
  })
})

describe("cards joining the dock (#672)", () => {
  const CARDS = [".bottom-dock > .permission", ".bottom-dock > .question", ".bottom-dock > .queued-messages"]

  it("fades the permission, question, and queued cards in as they rise from the composer", () => {
    expect(css).toMatch(/@keyframes dock-card-in \{\s*from \{\s*opacity: 0;\s*transform: translateY\(4px\);\s*\}\s*\}/)
    expect(ruleBody(CARDS.join(",\n"))).toMatch(/animation:\s*dock-card-in 0\.16s ease-out;/)
  })

  it("turns the entrance off under reduced motion", () => {
    const list = CARDS.map((c) => c.replace(/[.>]/g, (ch) => "\\" + ch)).join(",\\s*")
    expect(css).toMatch(new RegExp(`@media \\(prefers-reduced-motion: reduce\\) \\{\\s*${list} \\{\\s*animation: none;`))
  })

  // An opacity animation on either would make a backdrop root, and the glass
  // would blur nothing for as long as it ran.
  it("never animates the dock or its glass", () => {
    for (const selector of [".bottom-dock", ".bottom-dock-glass"]) {
      expect(ruleBody(selector)).not.toMatch(/\b(animation|transition)\s*:/)
    }
  })
})
