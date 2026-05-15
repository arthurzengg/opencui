import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { Markdown, normalizeMath } from "../../webview/src/components/Markdown"

afterEach(cleanup)

describe("normalizeMath", () => {
  it("rewrites display math \\[ ... \\] to $$ ... $$", () => {
    const out = normalizeMath("Solve \\[ x = 1 \\]")
    expect(out).toContain("$$")
    expect(out).toContain("x = 1")
    expect(out).not.toMatch(/\\\[/)
    expect(out).not.toMatch(/\\\]/)
  })

  it("rewrites inline math \\( ... \\) to $ ... $", () => {
    const out = normalizeMath("Where \\(a^2\\) is positive")
    expect(out).toMatch(/\$a\^2\$/)
    expect(out).not.toMatch(/\\\(/)
    expect(out).not.toMatch(/\\\)/)
  })

  it("leaves fenced code blocks untouched even if they contain LaTeX delimiters", () => {
    const input = "Outside \\(x\\)\n\n```js\nconst s = \"\\\\(literal\\\\)\"\n```\n\nMore \\[y\\]"
    const out = normalizeMath(input)
    // Outside the fence: rewritten
    expect(out).toMatch(/\$x\$/)
    expect(out).toMatch(/\$\$\ny\n\$\$/)
    // Inside the fence: the literal `\(...\)` source remains
    expect(out).toContain('const s = "\\\\(literal\\\\)"')
  })

  it("handles multiline display math", () => {
    const out = normalizeMath("\\[\n  a = b \\\\\n  c = d\n\\]")
    expect(out).toContain("a = b")
    expect(out).toContain("c = d")
    expect(out).toMatch(/\$\$[\s\S]+\$\$/)
  })

  it("is a no-op when the input has no LaTeX delimiters", () => {
    expect(normalizeMath("plain **markdown** text")).toBe("plain **markdown** text")
  })

  it("escapes $-followed-by-digit currency so it doesn't parse as math", () => {
    // Without the escape, remark-math would see `$5 and $10` as a math
    // expression spanning the two dollars.
    const out = normalizeMath("the plan costs $5 and the upgrade is $10")
    expect(out).toContain("\\$5")
    expect(out).toContain("\\$10")
  })

  it("doesn't escape $-followed-by-letter math like $x$", () => {
    // `$x^2$` should stay as math even though there's a leftover `$`.
    const out = normalizeMath("inline $x^2$ here")
    expect(out).toContain("$x^2$")
    expect(out).not.toContain("\\$x")
  })

  it("escapes currency without breaking adjacent LaTeX rewrites", () => {
    // Mixed: currency in one place, LaTeX in another — both handled.
    const out = normalizeMath("Costs $5; equation \\(a^2 + b^2\\)")
    expect(out).toContain("\\$5")
    expect(out).toMatch(/\$a\^2 \+ b\^2\$/)
  })
})

describe("Markdown component", () => {
  it("renders a paragraph as a real <p> (not the old .md-text div)", () => {
    const { container } = render(<Markdown text="Hello world" />)
    expect(container.querySelector("p")).not.toBeNull()
    expect(container.querySelector(".md-text")).toBeNull()
  })

  it("renders GFM tables produced by remark-gfm", () => {
    const md = "| a | b |\n| - | - |\n| 1 | 2 |"
    const { container } = render(<Markdown text={md} />)
    expect(container.querySelector("table")).not.toBeNull()
    expect(container.querySelector("th")?.textContent).toBe("a")
  })

  it("renders unordered lists", () => {
    const { container } = render(<Markdown text={"- one\n- two\n- three"} />)
    expect(container.querySelectorAll("li")).toHaveLength(3)
  })

  it("renders headings", () => {
    const { container } = render(<Markdown text={"# h1\n\n## h2"} />)
    expect(container.querySelector("h1")?.textContent).toBe("h1")
    expect(container.querySelector("h2")?.textContent).toBe("h2")
  })

  it("renders math via katex (produces .katex elements)", () => {
    const { container } = render(<Markdown text={"Equation: \\(n^3 \\equiv 14\\)"} />)
    expect(container.querySelector(".katex")).not.toBeNull()
  })

  it("renders block math via katex display class", () => {
    const { container } = render(<Markdown text={"\\[ n^3 + 17 \\equiv 0 \\pmod{31} \\]"} />)
    expect(container.querySelector(".katex-display")).not.toBeNull()
  })

  it("opens links in a new tab", () => {
    const { container } = render(<Markdown text="[click](https://example.com)" />)
    const a = container.querySelector("a")
    expect(a?.getAttribute("target")).toBe("_blank")
    expect(a?.getAttribute("rel")).toMatch(/noreferrer/)
  })

  it("renders single newlines as hard breaks (remark-breaks)", () => {
    // Reason 1\nReason 2\nReason 3 — no blank lines. CommonMark would
    // collapse these into one paragraph; remark-breaks turns each `\n`
    // into a <br>. JSX double-quoted attribute strings don't process
    // escapes, so use the JS-expression form `{...}` here.
    const { container } = render(<Markdown text={"Reason 1\nReason 2\nReason 3"} />)
    const brs = container.querySelectorAll("br")
    expect(brs.length).toBeGreaterThanOrEqual(2)
  })

  it("renders currency as literal dollars, not math", () => {
    const { container } = render(<Markdown text="the plan costs $5 and the upgrade is $10" />)
    // Both dollars survive as visible text, and no math element is produced.
    expect(container.textContent).toContain("$5")
    expect(container.textContent).toContain("$10")
    expect(container.querySelector(".katex")).toBeNull()
  })

  it("does not throw when given invalid LaTeX (tolerant rendering)", () => {
    // Half-finished delta arriving mid-stream — used to throw with the
    // default rehype-katex `throwOnError: true`. With our config, it
    // renders the partial expression (as a parse-error span) and keeps
    // going.
    expect(() => {
      render(<Markdown text="incomplete \\(n^3 \\eq" />)
    }).not.toThrow()
  })

  it("does not throw on completely malformed math", () => {
    expect(() => {
      render(<Markdown text="$\\frac{1}{$" />)
    }).not.toThrow()
  })
})
