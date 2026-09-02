import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import {
  Markdown,
  normalizeMath,
  normalizeAgentEnvelopes,
  prepareMarkdown,
} from "../../webview/src/components/Markdown"

afterEach(cleanup)

describe("unclosed fence (a code block still streaming in, #587)", () => {
  it("normalizeMath leaves the body of an unclosed fence alone but still rewrites the prose before it", () => {
    const out = normalizeMath("Price \\(p\\)\n\n```bash\necho $1 \\(x\\)")
    expect(out).toMatch(/\$p\$/)
    expect(out).toContain("echo $1 \\(x\\)")
  })

  it("normalizeAgentEnvelopes leaves envelope tags inside an unclosed fence alone", () => {
    const out = normalizeAgentEnvelopes("<answer>done</answer>\n\n```xml\n<analysis>raw</analysis>")
    expect(out).toContain("**Answer**")
    expect(out).toContain("<analysis>raw</analysis>")
    expect(out).not.toContain("**Analysis**")
  })

  it("a closed fence followed by an unclosed one skips both", () => {
    const out = normalizeMath("```\n$1\n```\ntext \\(a\\)\n```\n$2")
    expect(out).toContain("$1\n```")
    expect(out).toMatch(/\$a\$/)
    expect(out.endsWith("```\n$2")).toBe(true)
    expect(out).not.toContain("\\$")
  })

  it("prepareMarkdown counts math in prose only, whether the fence is closed or not", () => {
    expect(prepareMarkdown("```sh\necho $HOME\n```").hasMath).toBe(false)
    expect(prepareMarkdown("```sh\necho $HOME").hasMath).toBe(false)
    expect(prepareMarkdown("cost $x$ here").hasMath).toBe(true)
    expect(prepareMarkdown("<answer>\\(a\\)</answer>").source).toMatch(/\$a\$/)
  })

  it("renders a streaming code block's `$1` literally while the fence is still open", () => {
    const { container } = render(<Markdown text={"```bash\nkill $1"} streaming />)
    expect(container.textContent).toContain("kill $1")
    expect(container.textContent).not.toContain("\\$1")
  })
})

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

describe("normalizeAgentEnvelopes", () => {
  it("converts <analysis>…</analysis> to a bold-labelled markdown block", () => {
    const out = normalizeAgentEnvelopes("<analysis>I checked the imports.</analysis>")
    expect(out).toContain("**Analysis**")
    expect(out).toContain("I checked the imports.")
    expect(out).not.toMatch(/<\/?analysis>/i)
  })

  it("converts <answer>…</answer> to a bold-labelled markdown block", () => {
    const out = normalizeAgentEnvelopes("<answer>The hit is in foo.ts.</answer>")
    expect(out).toContain("**Answer**")
    expect(out).toContain("The hit is in foo.ts.")
    expect(out).not.toMatch(/<\/?answer>/i)
  })

  it("converts <next_steps>…</next_steps> with a spaced label", () => {
    const out = normalizeAgentEnvelopes("<next_steps>Read foo.ts and re-run tests.</next_steps>")
    expect(out).toContain("**Next steps**")
    expect(out).toContain("Read foo.ts and re-run tests.")
    expect(out).not.toMatch(/<\/?next_steps>/i)
  })

  it("strips the outer <results> wrapper and transforms inner tags", () => {
    const out = normalizeAgentEnvelopes(
      "<results><answer>found</answer><next_steps>open it</next_steps></results>",
    )
    expect(out).toContain("**Answer**")
    expect(out).toContain("**Next steps**")
    expect(out).not.toMatch(/<\/?results>/i)
    expect(out).not.toMatch(/<\/?answer>/i)
  })

  it("renders <files> as a bulleted list of code-spanned paths", () => {
    const out = normalizeAgentEnvelopes("<files>\n/abs/foo.ts\n/abs/bar.ts\n</files>")
    expect(out).toContain("**Files**")
    expect(out).toContain("- `/abs/foo.ts`")
    expect(out).toContain("- `/abs/bar.ts`")
    expect(out).not.toMatch(/<\/?files>/i)
  })

  it("emits nothing for an empty <files> block", () => {
    const out = normalizeAgentEnvelopes("before<files></files>after")
    expect(out).not.toMatch(/<\/?files>/i)
    expect(out).not.toMatch(/\*\*Files\*\*/)
    expect(out).toContain("before")
    expect(out).toContain("after")
  })

  it("leaves envelope tags inside fenced code blocks untouched", () => {
    const input = "Outside <analysis>x</analysis>\n\n```ts\nconst s = \"<analysis>literal</analysis>\"\n```"
    const out = normalizeAgentEnvelopes(input)
    expect(out).toContain("**Analysis**")
    expect(out).toContain('const s = "<analysis>literal</analysis>"')
  })

  it("is a no-op when no envelope tags are present", () => {
    const input = "plain **markdown** with no XML"
    expect(normalizeAgentEnvelopes(input)).toBe(input)
  })

  it("handles the full oh-my-openagent explore envelope end-to-end", () => {
    const input =
      "<analysis>Searched grep.</analysis>\n" +
      "<results>\n" +
      "<files>\n/Users/a/foo.ts\n/Users/a/bar.ts\n</files>\n" +
      "<answer>Two hits — both call the helper.</answer>\n" +
      "<next_steps>Open foo.ts first.</next_steps>\n" +
      "</results>"
    const out = normalizeAgentEnvelopes(input)
    expect(out).toContain("**Analysis**")
    expect(out).toContain("**Files**")
    expect(out).toContain("- `/Users/a/foo.ts`")
    expect(out).toContain("**Answer**")
    expect(out).toContain("**Next steps**")
    // No raw tags survive.
    expect(out).not.toMatch(/<\/?(analysis|results|files|answer|next_steps)>/i)
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

  it("renders oh-my-openagent's <files> envelope as a bulleted list with code paths", () => {
    const { container } = render(
      <Markdown text={"<files>\n/abs/foo.ts\n/abs/bar.ts\n</files>"} />,
    )
    // Bold label, two list items, each path wrapped in a <code> span.
    expect(container.querySelector("strong")?.textContent).toBe("Files")
    expect(container.querySelectorAll("li")).toHaveLength(2)
    const codes = Array.from(container.querySelectorAll("li code")).map((c) => c.textContent)
    expect(codes).toEqual(["/abs/foo.ts", "/abs/bar.ts"])
  })
})
