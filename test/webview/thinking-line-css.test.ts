import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const css = readFileSync(path.resolve(__dirname, "../../webview/src/styles.css"), "utf8")

// The light on the live line is decoration. It is opted into, so that
// reduced motion and the high-contrast themes get plain words without a
// reset rule anyone could forget (#798).
describe("the light on the live line", () => {
  // Every rule that runs the animation: selector, then the whole rule text.
  const uses = [...css.matchAll(/^([^\n{}]*)\{[^{}]*\}/gm)].filter((m) => /animation:[^;]*thinking-sweep/.test(m[0]))

  it("is only ever applied inside the no-preference motion query", () => {
    const block = css.match(/@media \(prefers-reduced-motion: no-preference\) \{\n((?:  [^\n]*\n|\n)*)\}/)
    expect(block).not.toBeNull()
    expect(uses.length).toBeGreaterThan(0)
    for (const use of uses) expect(block![1]).toContain(use[0])
  })

  it("is never applied in a high-contrast theme", () => {
    for (const use of uses) {
      expect(use[1].trim()).toMatch(/^body:not\(\.vscode-high-contrast\):not\(\.vscode-high-contrast-light\) /)
    }
  })
})
