import { memo, useEffect, useMemo, useState } from "react"
import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { loadGrammar } from "../grammar-loader"
import { GRAMMAR_FILE } from "../shiki-langs"
import { vscode } from "../vscode"

type Props = { code: string; language?: string }

/**
 * The highlighter starts with the two GitHub themes and NO grammars — the
 * grammar set was ~2.2MB of the 3.7MB single-file bundle, re-parsed on every
 * panel open. Grammars now ship as dist/webview/grammars/*.json and load on
 * the first block that needs one (see grammar-loader.ts). The JavaScript
 * regex engine replaces the oniguruma wasm; `forgiving` skips patterns it
 * cannot compile instead of failing the whole highlight. `text` is shiki's
 * built-in plaintext passthrough.
 */
let highlighterPromise: Promise<HighlighterCore> | undefined
function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [
      import("@shikijs/themes/github-dark-default"),
      import("@shikijs/themes/github-light-default"),
    ],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
  return highlighterPromise
}

// One fetch+register per grammar file, shared across blocks. A failed load is
// evicted so a later block retries instead of inheriting the rejection.
const grammarLoads = new Map<string, Promise<void>>()
function ensureLang(highlighter: HighlighterCore, lang: string): Promise<void> {
  if (lang === "text") return Promise.resolve()
  const file = GRAMMAR_FILE[lang]!
  let load = grammarLoads.get(file)
  if (!load) {
    load = loadGrammar(file).then((regs) => highlighter.loadLanguage(...regs))
    grammarLoads.set(file, load)
    load.catch(() => grammarLoads.delete(file))
  }
  return load
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
        .then(async (highlighter) => {
          await ensureLang(highlighter, lang)
          return highlighter.codeToHtml(code, { lang, theme })
        })
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
  return Object.hasOwn(GRAMMAR_FILE, normalised) ? normalised : "text"
}

function isDarkColor(c: string): boolean {
  const m = c.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/)
  if (!m) return true
  const [r, g, b] = [+m[1], +m[2], +m[3]]
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum < 140
}
