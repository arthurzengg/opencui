import { useEffect, useMemo, useState } from "react"
import { codeToHtml, type BundledLanguage } from "shiki/bundle/web"
import { vscode } from "../vscode"

type Props = { code: string; language?: string }

const SUPPORTED = new Set<string>([
  "typescript", "tsx", "javascript", "jsx", "python", "bash", "shell",
  "json", "html", "css", "yaml", "markdown", "md", "go", "rust", "java",
  "sql", "c", "cpp", "csharp", "ruby", "php", "swift", "kotlin", "toml",
  "xml", "docker", "dockerfile", "ini", "diff",
])

export function CodeBlock({ code, language }: Props) {
  const [html, setHtml] = useState<string>("")
  const [copied, setCopied] = useState(false)
  const theme = useMemo(() => {
    const bg = getComputedStyle(document.body).backgroundColor
    const dark = !bg || isDarkColor(bg)
    return dark ? "github-dark-default" : "github-light-default"
  }, [])

  useEffect(() => {
    let cancelled = false
    const lang = normaliseLang(language)
    codeToHtml(code, { lang: lang as BundledLanguage, theme })
      .then((h) => {
        if (!cancelled) setHtml(h)
      })
      .catch(() => {
        if (!cancelled) setHtml(`<pre><code>${escape(code)}</code></pre>`)
      })
    return () => {
      cancelled = true
    }
  }, [code, language, theme])

  const lang = normaliseLang(language)
  const onApply = () => vscode.post({ type: "apply", code, language })
  const onCopy = () =>
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      },
      () => {},
    )

  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="codeblock-lang">{lang}</span>
        <div className="codeblock-actions">
          <button className="btn compact" onClick={onCopy} title="Copy">
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="btn compact primary" onClick={onApply} title="Apply to active file">
            Apply
          </button>
        </div>
      </div>
      {html ? (
        <div className="codeblock-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="codeblock-body"><code>{code}</code></pre>
      )}
    </div>
  )
}

function escape(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

function normaliseLang(l?: string): string {
  if (!l) return "text"
  const map: Record<string, string> = { ts: "typescript", js: "javascript", py: "python", sh: "bash", shell: "bash", md: "markdown" }
  const normalised = map[l] ?? l
  return SUPPORTED.has(normalised) ? normalised : "text"
}

function isDarkColor(c: string): boolean {
  const m = c.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/)
  if (!m) return true
  const [r, g, b] = [+m[1], +m[2], +m[3]]
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum < 140
}
