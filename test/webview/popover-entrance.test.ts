import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const css = readFileSync(path.resolve(__dirname, "../../webview/src/styles.css"), "utf8")

type Rule = { selectors: string[]; body: string }

/** Top-level rules, plus the rules inside every reduced-motion block. */
function parse(): { rules: Rule[]; reducedMotion: Rule[] } {
  const rules: Rule[] = []
  const reducedMotion: Rule[] = []
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "")
  const src = strip(css)
  const mediaRe = /@media \(prefers-reduced-motion: reduce\) \{((?:[^{}]*\{[^{}]*\})*)\s*\}/g
  for (const m of src.matchAll(mediaRe)) {
    for (const r of m[1].matchAll(ruleRe)) {
      reducedMotion.push({ selectors: r[1].split(",").map((x) => x.trim()), body: r[2] })
    }
  }
  for (const r of src.replace(mediaRe, "").matchAll(ruleRe)) {
    if (r[1].trim().startsWith("@")) continue
    rules.push({ selectors: r[1].split(",").map((x) => x.trim()), body: r[2] })
  }
  return { rules, reducedMotion }
}

const { rules, reducedMotion } = parse()

function animationOf(list: Rule[], selector: string): string | undefined {
  let value: string | undefined
  for (const rule of list) {
    if (!rule.selectors.includes(selector)) continue
    const m = rule.body.match(/(?:^|;|\s)animation:\s*([^;]+);/)
    if (m) value = m[1].trim()
  }
  return value
}

const HEADER_POPOVERS = [".history-popover", ".model-picker-popover", ".agents-popover"]

describe("popover entrance (#670)", () => {
  it("fades the popover in from a small offset", () => {
    const m = css.match(/@keyframes popover-in \{([\s\S]*?)\n\}/)
    expect(m).not.toBeNull()
    expect(m![1]).toMatch(/from \{[^}]*opacity:\s*0;[^}]*transform:\s*translateY\(var\(--popover-from, -4px\)\);/)
  })

  it.each(HEADER_POPOVERS)("animates %s in on open", (selector) => {
    expect(animationOf(rules, selector)).toBe("popover-in 0.12s ease-out")
  })

  it.each(HEADER_POPOVERS)("turns %s's entrance off under reduced motion", (selector) => {
    expect(animationOf(reducedMotion, selector)).toBe("none")
  })
})
