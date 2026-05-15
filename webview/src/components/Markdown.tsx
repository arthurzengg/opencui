import { isValidElement, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import "katex/dist/katex.min.css"
import { CodeBlock } from "./CodeBlock"

type Props = { text: string }

// remark-math recognises `$…$` (inline) and `$$…$$` (display), but reasoning
// models commonly emit raw LaTeX `\(…\)` / `\[…\]` delimiters instead. Rewrite
// them to dollar form before parsing — but only OUTSIDE fenced code blocks, so
// code samples that legitimately contain those sequences stay verbatim.
export function normalizeMath(input: string): string {
  const out: string[] = []
  const fence = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = fence.exec(input)) !== null) {
    out.push(rewriteLatex(input.slice(last, m.index)))
    out.push(m[0])
    last = m.index + m[0].length
  }
  out.push(rewriteLatex(input.slice(last)))
  return out.join("")
}

function rewriteLatex(s: string): string {
  return s
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, body) => `\n$$\n${body.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, body) => `$${body.trim()}$`)
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

export function Markdown({ text }: Props) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  )
}
