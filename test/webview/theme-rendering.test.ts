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

// The default dark themes of VS Code 1.143 leave `button.secondaryBackground`
// transparent and draw secondary buttons with a border. A surface that borrows
// the secondary fill without that border is bare text there (#746).
describe("surfaces on the secondary button fill", () => {
  const surfaces = [".btn", ".selector-trigger", ".msg-retry"]

  it.each(surfaces)("%s draws the theme's secondary button border", (selector) => {
    const body = ruleBody(selector)
    expect(body).toContain("background: var(--vscode-button-secondaryBackground)")
    expect(body).toContain("border: 1px solid var(--secondary-border)")
  })

  // `button.border` alone is the primary button's border: Dark 2026 sets it to
  // the theme's blue, which ringed the model selector and every secondary
  // button (#751). VS Code's own secondary buttons use this chain.
  it("resolves the secondary border before the general one, and keeps the primary button off both", () => {
    expect(ruleBody(":root")).toContain(
      "--secondary-border:   var(--vscode-button-secondaryBorder, var(--vscode-button-border, transparent));",
    )
    expect(ruleBody(".btn.primary")).toContain("border-color: var(--accent-fill-border)")
    expect(ruleBody(":root")).toContain("--accent-fill-border: transparent;")
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

// A history row's date and a review row's counts share one cell with the row's
// actions (#756). Columns reserved for the hidden actions left the date and
// the counts mid-row, and truncated names beside blank space.
describe("row actions", () => {
  it("reserves no column for actions that are hidden at rest", () => {
    expect(ruleBody(".history-item")).toContain("grid-template-columns: minmax(0, 1fr) auto;")
    expect(ruleBody(".review-file")).toContain('grid-template-areas: "kind name tail";')
    for (const selector of [".history-tail > *", ".review-file-tail > *"]) {
      expect(ruleBody(selector), selector).toContain("grid-area: 1 / 1")
    }
  })

  it("keeps the faded date and counts from taking the clicks meant for the actions under them", () => {
    for (const selector of [".history-date", ".review-file-stats"]) {
      expect(ruleBody(selector), selector).toContain("pointer-events: none")
    }
  })
})

// The trace is one grid and every section and row a subgrid of it, so the
// icons share a column and the details another whatever the verbs' lengths
// (#756). A row laid out on its own would start its detail where its verb ends.
describe("process trace", () => {
  it("lays every section and row out on the trace's columns", () => {
    const onTheGrid = [".trace-edits", ".trace-reads", ".trace-others", ".trace-dispatch", ".edit-row", ".other-row"]
    expect(css).toContain(`${onTheGrid.join(",\n")} {\n  display: grid;\n  grid-template-columns: subgrid;\n  grid-column: 1 / -1;`)
  })

  it("stops the running spinner under reduced motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.trace-icon\.codicon-modifier-spin \{\s*animation: none;/)
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



// The request cards follow Claude's own (#750): type-led, no pictograph.
describe("request cards", () => {
  it("carry no emoji in their markup", () => {
    const sources = ["PermissionDialog.tsx", "QuestionDialog.tsx"].map((file) =>
      readFileSync(resolve(__dirname, "../../webview/src/components", file), "utf8"),
    )
    for (const source of sources) expect(source).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  it("break the permission pattern between words only", () => {
    const token = ruleBody(".permission-token")
    expect(token).toContain("display: inline-block")
    expect(token).toContain("max-width: 100%")
  })

  it("hide the question's free-text field while an option holds the answer", () => {
    expect(ruleBody(".question-custom:disabled")).toContain("display: none")
    expect(ruleBody(".question-custom")).toContain("resize: none")
  })
})
