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

describe("glass surfaces (#790)", () => {
  it("leaves the opaque surfaces in place under reduced transparency and high contrast", () => {
    expect(css).toContain(GUARD)
    const selectors = rules.flatMap((rule) => rule.selectors)
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) expect(selector.startsWith(`${PREFIX} `)).toBe(true)
  })
})
