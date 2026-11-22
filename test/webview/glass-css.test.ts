import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const css = readFileSync(path.resolve(__dirname, "../../webview/src/styles.css"), "utf8")
const GUARD = "@media not all and (prefers-reduced-transparency: reduce) {"
const PREFIX = "body:not(.vscode-high-contrast):not(.vscode-high-contrast-light)"

const rules = css
  .slice(css.indexOf(GUARD))
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n  }\n")
  .map((chunk) => {
    const lines = chunk.split("\n")
    return {
      selectors: lines.filter((line) => /^ {2}\S/.test(line)).map((line) => line.replace(/[,{]\s*$/, "").trim()),
      body: lines.filter((line) => /^ {4}/.test(line)).join("\n"),
    }
  })

/** Declarations of every glass rule that names `selector`. */
function declarations(selector: string): string {
  const named = rules.filter((rule) => rule.selectors.includes(`${PREFIX} ${selector}`))
  if (named.length === 0) throw new Error(`glass rule not found: ${selector}`)
  return named.map((rule) => rule.body).join("\n")
}

describe("glass surfaces (#790)", () => {
  it("leaves the opaque surfaces in place under reduced transparency and high contrast", () => {
    expect(css).toContain(GUARD)
    const selectors = rules.flatMap((rule) => rule.selectors)
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) expect(selector.startsWith(`${PREFIX} `)).toBe(true)
  })

  // A backdrop-filter makes its element the backdrop root of what is inside it
  // and the containing block of its fixed descendants: on the pinned question
  // the image preview would be confined to the bubble, and on a bubble being
  // edited or on the composer the pickers would blur nothing.
  it("keeps the filter off the elements that hold the pickers and the image preview", () => {
    for (const host of [".msg.role-user", ".user-edit-layer", ".promptbox--bottom"]) {
      expect(declarations(host)).not.toContain("backdrop-filter")
    }
    for (const glass of [".msg.role-user::before", ".user-edit-layer::before", ".promptbox--bottom::before"]) {
      expect(declarations(glass)).toContain("backdrop-filter")
    }
  })

  // The owner asked for the blur above the composer to go: the transcript
  // stays sharp down to the cards, and each card blurs what is behind it.
  it("switches the dock's blur ramp off", () => {
    expect(declarations(".bottom-dock-glass")).not.toContain("backdrop-filter")
    for (const layer of [".bottom-dock-glass::before", ".bottom-dock-glass::after"]) {
      expect(declarations(layer)).toContain("display: none")
    }
  })

  // A card that animates in is below full opacity on the way, which makes it
  // a backdrop root: a filter on a child would blur nothing until the
  // animation ends, and the transcript would snap out of focus behind it.
  it("puts the filter of a card that animates in on the card itself", () => {
    for (const card of [".bottom-dock > .permission", ".bottom-dock > .question", ".queued-messages"]) {
      expect(declarations(card)).toContain("backdrop-filter")
    }
    expect(declarations(".queued-row")).not.toContain("backdrop-filter")
  })

  // The two names glass-refraction.ts shares with the stylesheet: a rename on
  // one side leaves the pinned question without its bend and nothing fails.
  it("names the blur the refraction script reads and takes its filter back", () => {
    expect(declarations(".msg.role-user")).toMatch(/--glass-surface-blur: \d/)
    expect(declarations(".msg.role-user::before")).toContain("backdrop-filter: var(--glass-refraction,")
  })
})
