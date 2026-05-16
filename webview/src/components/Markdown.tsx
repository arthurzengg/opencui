import { isValidElement, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import "katex/dist/katex.min.css"
import { CodeBlock } from "./CodeBlock"

type Props = { text: string }

// Private Use Area code points — won't appear in normal text or LaTeX
// source, so we use them as sentinels for the three-step rewrite below.
const D_OPEN = ""
const D_CLOSE = ""
const I_OPEN = ""
const I_CLOSE = ""

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
  const out: string[] = []
  const fence = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = fence.exec(input)) !== null) {
    out.push(rewriteOutsideCode(input.slice(last, m.index)))
    out.push(m[0])
    last = m.index + m[0].length
  }
  out.push(rewriteOutsideCode(input.slice(last)))
  return out.join("")
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

export function Markdown({ text }: Props) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
        rehypePlugins={[[rehypeKatex, katexOptions]]}
        components={components}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  )
}
