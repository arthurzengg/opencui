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

// Dark Modern in VS Code 1.143 leaves `button.secondaryBackground` transparent
// and draws its buttons with `button.border`. A surface that borrows the
// secondary fill without that border is bare text there (#746).
describe("surfaces on the secondary button fill", () => {
  const surfaces = [".btn", ".selector-trigger", ".msg-retry"]

  it.each(surfaces)("%s draws the theme's button border", (selector) => {
    const body = ruleBody(selector)
    expect(body).toContain("background: var(--vscode-button-secondaryBackground)")
    expect(body).toContain("border: 1px solid var(--vscode-button-border, transparent)")
  })

  it("has no other surface on that fill", () => {
    expect(css.split("background: var(--vscode-button-secondaryBackground)").length - 1).toBe(surfaces.length)
  })
})

// A sticky box pins at the top of the scroller's content box, so the
// scroller's top padding is a band the transcript scrolls through in plain
// view between the header and the pinned bubble (#746).
describe("sticky user bubble", () => {
  it("covers the scroller's top padding above itself without taking clicks", () => {
    expect(ruleBody(".messages")).toContain("padding: var(--messages-pad-top) ")
    const cover = ruleBody(".msg.role-user::before")
    expect(cover).toContain("height: var(--messages-pad-top)")
    expect(cover).toContain("bottom: calc(100% + var(--bubble-border-width))")
    expect(cover).toContain("background: var(--color-bg-panel)")
    expect(cover).toContain("pointer-events: none")
  })
})

// The hint is absolutely positioned over the bubble's top right corner, so
// the text has to stop short of it, by the same amount in the edit-mode
// textarea and backdrop or entering edit mode re-wraps the message (#746).
describe("user bubble text and the edit hint", () => {
  it("ends the text column clear of the hint in view and edit mode alike", () => {
    const columns = [
      ".msg.role-user .user-text",
      '.msg.role-user:not([data-edit-phase="view"]) .promptbox textarea',
      '.msg.role-user:not([data-edit-phase="view"]) .promptbox .promptbox-backdrop',
    ]
    for (const rule of columns) expect(ruleBody(rule)).toContain("padding-right: var(--bubble-text-gutter)")
    const hint = ruleBody(".user-edit-hint")
    expect(hint).toContain("right: var(--bubble-hint-inset)")
    expect(hint).toContain("width: var(--bubble-hint-size)")
  })
})

describe("review card counts", () => {
  it("hides a zero count instead of removing its cell, which would shift the other count (#746)", () => {
    expect(css).toContain(".review-stat.is-zero,\n.review-file-stat.is-zero {\n  visibility: hidden;\n}")
  })
})

// The panel's accent is the theme's text colour, not its accent hue (#748).
// A high-contrast theme keeps its own accent through one override block.
describe("neutral accent", () => {
  const start = css.indexOf("\nbody.vscode-high-contrast,")
  const end = css.indexOf("}", start)
  const highContrast = css.slice(start, end)
  const rest = css.slice(0, start) + css.slice(end)

  it("derives the accent tokens from the theme's text colour", () => {
    const root = ruleBody(":root")
    for (const token of ["--accent:", "--accent-line:", "--accent-fill:", "--selection-bg:"]) {
      const declaration = root.split("\n").find((line) => line.trim().startsWith(token))
      expect(declaration, token).toContain("var(--vscode-foreground)")
    }
  })

  it("reads the theme's accent colours only in the high-contrast override", () => {
    const themeAccent = [
      "--vscode-button-background",
      "--vscode-button-hoverBackground",
      "--vscode-button-foreground",
      "--vscode-list-activeSelectionBackground",
      "--vscode-list-activeSelectionForeground",
      "--vscode-progressBar-background",
      "--vscode-focusBorder",
    ]
    for (const token of themeAccent) expect(rest, token).not.toContain(token)
    expect(highContrast).toContain("--accent-fill:       var(--vscode-button-background);")
    expect(highContrast).toContain("--accent:            var(--vscode-focusBorder);")
    expect(highContrast).toContain("--selection-bg:      var(--vscode-list-activeSelectionBackground")
  })

  // A button keeps focus after a click, and the next key press, a bare
  // modifier included, reveals its outline. In the theme's blue that read as
  // an accent the panel no longer has.
  it("draws keyboard focus outlines in the accent", () => {
    expect(ruleBody("button:focus-visible")).toContain("outline: 1px solid var(--accent);")
  })
})

