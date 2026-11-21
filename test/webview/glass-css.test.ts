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
  // edited the pickers would blur nothing.
  it("keeps the filter off the elements that hold the pickers and the image preview", () => {
    for (const host of [".msg.role-user", ".user-edit-layer"]) {
      expect(declarations(host)).not.toContain("backdrop-filter")
    }
    expect(declarations(".msg.role-user::before")).toContain("backdrop-filter")
    expect(declarations(".user-edit-layer::before")).toContain("backdrop-filter")
  })
})
