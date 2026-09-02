import { isValidElement, memo, useMemo, type ReactNode } from "react"
import ReactMarkdown, { type Components, type Options } from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import "katex/dist/katex.min.css"
import { CodeBlock } from "./CodeBlock"
import { useThrottledValue } from "../hooks/useThrottledValue"

/**
 * `streaming` marks text that is still growing (a pending message). The
 * remark/rehype parse then samples the text at ~20 fps instead of re-running
 * on every coalesced frame; settled messages stay pass-through.
 */
type Props = { text: string; streaming?: boolean }

const STREAM_PARSE_MS = 50

// Private Use Area code points — won't appear in normal text or LaTeX
// source, so we use them as sentinels for the three-step rewrite below.
const D_OPEN = ""
const D_CLOSE = ""
const I_OPEN = ""
const I_CLOSE = ""

/**
 * Some agent packs (notably oh-my-openagent's `explore` agent) emit their
 * answer wrapped in literal XML envelopes:
 *
 *   <analysis>…reasoning…</analysis>
 *   <results>
 *     <files>/abs/path/foo.ts\n/abs/path/bar.ts</files>
 *     <answer>…</answer>
 *     <next_steps>…</next_steps>
 *   </results>
 *
 * react-markdown escapes raw HTML, so without this pre-processor the user
 * sees the literal tags in their bubble. We don't accept arbitrary HTML
 * pass-through (XSS risk in a webview), so instead we transform a small
 * known set of envelope tags into bold-labelled markdown sections.
 *
 * Applied OUTSIDE fenced code blocks so that a teaching example like
 * ```ts
 *   "<analysis>..."
 * ```
 * survives unmodified.
 */
const ENVELOPE_LABELS: Record<string, string> = {
  analysis: "Analysis",
  answer: "Answer",
  next_steps: "Next steps",
}

// An unclosed fence runs to the end of input, matching CommonMark and what
// remark will do with the same text. Mid-stream the block is still being
// typed; treating its body as prose rewrote `$1`, `\(…\)`, and envelope tags
// inside code until the closer arrived (#587).
const FENCE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g

type Segment = { code: boolean; text: string }

function splitFences(input: string): Segment[] {
  const out: Segment[] = []
  const fence = new RegExp(FENCE.source, "g")
  let last = 0
  let m: RegExpExecArray | null
  while ((m = fence.exec(input)) !== null) {
    if (m.index > last) out.push({ code: false, text: input.slice(last, m.index) })
    out.push({ code: true, text: m[0] })
    last = m.index + m[0].length
  }
  out.push({ code: false, text: input.slice(last) })
  return out
}

function mapProse(input: string, fn: (prose: string) => string): string {
  return splitFences(input)
    .map((s) => (s.code ? s.text : fn(s.text)))
    .join("")
}

export function normalizeAgentEnvelopes(input: string): string {
  return mapProse(input, rewriteEnvelopesOutsideCode)
}

function rewriteEnvelopesOutsideCode(s: string): string {
  // Strip the outer <results>…</results> wrapper — its inner tags carry the
  // meaningful content. We leave any unrecognized inner tags as-is on
  // purpose; surfacing them as raw text is a useful signal that the agent
  // pack has shapes opencui doesn't render yet.
  let out = s.replace(/<\/?results>\s*/gi, "\n\n")
  // <files>: one path per line → bulleted list of code-spanned paths so the
  // narrow sidebar renders each on its own row.
  out = out.replace(/<files>([\s\S]*?)<\/files>/gi, (_, body: string) => {
    const items = body.split("\n").map((l) => l.trim()).filter(Boolean)
    if (items.length === 0) return ""
    return `\n\n**Files**\n\n${items.map((p) => `- \`${p}\``).join("\n")}\n\n`
  })
  for (const [tag, label] of Object.entries(ENVELOPE_LABELS)) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi")
    out = out.replace(re, (_, body: string) => `\n\n**${label}**\n\n${body.trim()}\n\n`)
  }
  return out
}

/**
 * remark-math wants `$…$` (inline) and `$$…$$` (display). Reasoning models
 * commonly emit LaTeX `\(…\)` / `\[…\]` instead, and prose containing
 * currency like `$5 and $10` would otherwise parse as accidental math.
 *
 * Three-step rewrite, applied OUTSIDE fenced code blocks only:
 *   1. Replace `\[ \] \( \)` with sentinel code points so the original
 *      `$` chars in the text are clearly distinguishable from any that
 *      we introduce.
 *   2. Escape any leftover `$` immediately followed by a digit
 *      (overwhelmingly currency — math expressions almost never start
 *      with a bare digit). Escaped `\$` renders as a literal dollar.
 *   3. Restore sentinels back to dollar-form math delimiters.
 *
 * False negative: a math expression genuinely starting with a digit
 * (`$1 + 2$`) won't render as math. Accepted — LLM math output uses
 * variables and `\(…\)`, not bare numeric kernels.
 */
export function normalizeMath(input: string): string {
  return mapProse(input, rewriteOutsideCode)
}

// Math is comparatively expensive: normalizeMath's regex passes, the
// remark-math tokenizer, and the rehype-katex tree walk all re-run on every
// render of a streaming message. Most chat messages contain no math, so detect
// the delimiters once and skip the whole math pipeline when there are none.
// Covers `$…$` / `$$…$$` plus the `\(…\)` / `\[…\]` forms normalizeMath would
// convert into dollar math. Currency like `$5` trips this too — intentional:
// the pipeline then escapes it correctly, exactly as before.
const MATH_HINT = /\$|\\\(|\\\[/

/**
 * The component's single pre-parse pass: envelope rewrite, math detection,
 * and math rewrite, each restricted to prose. `hasMath` reflects prose only —
 * a `$` inside a code block (a shell variable, say) used to switch on
 * remark-math + katex for the whole segment.
 */
export function prepareMarkdown(input: string): { source: string; hasMath: boolean } {
  let hasMath = false
  const source = splitFences(input)
    .map((s) => {
      if (s.code) return s.text
      const prose = rewriteEnvelopesOutsideCode(s.text)
      if (!MATH_HINT.test(prose)) return prose
      hasMath = true
      return rewriteOutsideCode(prose)
    })
    .join("")
  return { source, hasMath }
}

function rewriteOutsideCode(s: string): string {
  // Step 1: stash LaTeX delimiters behind sentinels.
  let out = s
    .replace(/\\\[/g, D_OPEN)
    .replace(/\\\]/g, D_CLOSE)
    .replace(/\\\(/g, I_OPEN)
    .replace(/\\\)/g, I_CLOSE)

  // Step 2: any `$` left in the text is from the original message. Escape
  // those that look like currency so remark-math leaves them alone.
  out = out.replace(/(?<!\\)\$(?=\d)/g, "\\$")

  // Step 3: rehydrate sentinels into dollar-form math delimiters.
  out = out
    .replace(new RegExp(D_OPEN + "([\\s\\S]+?)" + D_CLOSE, "g"), (_, body) =>
      `\n$$\n${body.trim()}\n$$\n`,
    )
    .replace(new RegExp(I_OPEN + "([\\s\\S]+?)" + I_CLOSE, "g"), (_, body) =>
      `$${body.trim()}$`,
    )
  return out
}

const components: Components = {
  // react-markdown wraps fenced code as <pre><code class="language-x">…</code></pre>.
  // We render the CodeBlock ourselves (it owns the shiki highlight + Copy/Apply
  // buttons), so drop the <pre> shell and let the `code` override handle both
  // shapes via the className probe.
  pre({ children }) {
    return <>{children}</>
  },
  code({ className, children, ...rest }) {
    const match = /language-([\w+-]+)/.exec(className || "")
    if (match) {
      const code = flattenChildren(children).replace(/\n$/, "")
      return <CodeBlock code={code} language={match[1]} />
    }
    return <code className={className} {...rest}>{children}</code>
  },
  // Open links in a new tab — the webview's anchor handler swallows
  // same-tab navigations, so external links would otherwise look broken.
  a({ href, children, ...rest }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" {...rest}>
        {children}
      </a>
    )
  },
}

function flattenChildren(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(flattenChildren).join("")
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode }
    return flattenChildren(props.children)
  }
  return ""
}

// `strict: 'ignore'` + `throwOnError: false`: half-formed LaTeX arrives
// mid-stream as the model emits deltas; without this, a partial
// expression like `\(n^3 \eq` makes rehype-katex throw and kill the
// whole message render. With these flags it renders the malformed bit
// as faint red text and keeps going.
const katexOptions = { strict: "ignore", throwOnError: false } as const

const PROSE_REMARK: NonNullable<Options["remarkPlugins"]> = [remarkGfm, remarkBreaks]
const MATH_REMARK: NonNullable<Options["remarkPlugins"]> = [remarkGfm, remarkBreaks, remarkMath]
const MATH_REHYPE: NonNullable<Options["rehypePlugins"]> = [[rehypeKatex, katexOptions]]
const NO_REHYPE: NonNullable<Options["rehypePlugins"]> = []

function MarkdownImpl({ text, streaming = false }: Props) {
  const sampled = useThrottledValue(text, streaming ? STREAM_PARSE_MS : 0)
  // react-markdown parses inside render, and this component re-renders on
  // every frame the growing `text` prop arrives on. Memoizing the element,
  // not just the pre-parse, is what lets React skip that render while the
  // sample is unchanged; a fresh element re-parsed on every frame (#597).
  const body = useMemo(() => {
    const { source, hasMath } = prepareMarkdown(sampled)
    return (
      <ReactMarkdown
        remarkPlugins={hasMath ? MATH_REMARK : PROSE_REMARK}
        rehypePlugins={hasMath ? MATH_REHYPE : NO_REHYPE}
        components={components}
      >
        {source}
      </ReactMarkdown>
    )
  }, [sampled])
  return <div className="md">{body}</div>
}

// Memoized on `text` (its only prop): every settled segment above the one
// currently streaming skips the full remark/rehype re-parse when an unrelated
// part of the tree re-renders.
export const Markdown = memo(MarkdownImpl)
