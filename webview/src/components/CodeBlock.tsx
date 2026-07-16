import { memo, useEffect, useMemo, useState } from "react"
import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { vscode } from "../vscode"

type Props = { code: string; language?: string }

const SUPPORTED = new Set<string>([
  "typescript", "tsx", "javascript", "jsx", "python", "bash", "shell",
  "json", "html", "css", "yaml", "markdown", "md", "go", "rust", "java",
  "sql", "c", "cpp", "csharp", "ruby", "php", "swift", "kotlin", "toml",
  "xml", "docker", "dockerfile", "ini", "diff",
])

/**
 * Fine-grained shiki: only the SUPPORTED grammars and the two GitHub themes
 * get bundled — `shiki/bundle/web` shipped every web language, every theme,
 * and the oniguruma wasm (~5.3 MB of bundle input). The JavaScript regex
 * engine replaces the wasm; `forgiving` skips grammar patterns it cannot
 * compile instead of failing the whole highlight. Constructed lazily on the
 * first fenced code block; aliases (bash/shell/md/docker/…) ride along on
 * their canonical grammar registrations, and `text` is shiki's built-in
 * plaintext passthrough.
 */
let highlighterPromise: Promise<HighlighterCore> | undefined
function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [
      import("@shikijs/themes/github-dark-default"),
      import("@shikijs/themes/github-light-default"),
    ],
    langs: [
      import("@shikijs/langs/typescript"),
      import("@shikijs/langs/tsx"),
      import("@shikijs/langs/javascript"),
      import("@shikijs/langs/jsx"),
      import("@shikijs/langs/python"),
      import("@shikijs/langs/shellscript"),
      import("@shikijs/langs/json"),
      import("@shikijs/langs/html"),
      import("@shikijs/langs/css"),
      import("@shikijs/langs/yaml"),
      import("@shikijs/langs/markdown"),
      import("@shikijs/langs/go"),
      import("@shikijs/langs/rust"),
      import("@shikijs/langs/java"),
      import("@shikijs/langs/sql"),
      import("@shikijs/langs/c"),
      import("@shikijs/langs/cpp"),
      import("@shikijs/langs/csharp"),
      import("@shikijs/langs/ruby"),
      import("@shikijs/langs/php"),
      import("@shikijs/langs/swift"),
      import("@shikijs/langs/kotlin"),
      import("@shikijs/langs/toml"),
      import("@shikijs/langs/xml"),
      import("@shikijs/langs/dockerfile"),
      import("@shikijs/langs/ini"),
      import("@shikijs/langs/diff"),
    ],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
  return highlighterPromise
}

// While a fenced block streams in, `code` grows on every delta. Debounce the
// shiki tokenization so it runs once the content settles instead of
// re-highlighting the whole (immediately superseded) snippet on each token.
const HIGHLIGHT_DEBOUNCE_MS = 90

function CodeBlockImpl({ code, language }: Props) {
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
    const timer = setTimeout(() => {
      getHighlighter()
        .then((highlighter) => highlighter.codeToHtml(code, { lang, theme }))
        .then((h) => {
          if (!cancelled) setHtml(h)
        })
        .catch(() => {
          if (!cancelled) setHtml(`<pre><code>${escape(code)}</code></pre>`)
        })
    }, HIGHLIGHT_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code, language, theme])

  const lang = normaliseLang(language)
  const isShell = lang === "bash"
  const onApply = () => {
    vscode.post({ type: "apply", code, language })
    // Return focus to the chat input so the user can keep the conversation
    // going right after Run/Apply, instead of having to click the textarea.
    requestAnimationFrame(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".promptbox textarea")
      textarea?.focus()
    })
  }
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
          <button
            className="btn compact primary"
            onClick={onApply}
            title={isShell ? "Send to integrated terminal" : "Apply to active file"}
          >
            {isShell ? "Run" : "Apply"}
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

export const CodeBlock = memo(CodeBlockImpl)

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
