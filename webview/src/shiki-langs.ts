/**
 * Language → grammar-file map, shared by CodeBlock (what to fetch at runtime)
 * and vite.config.ts (what to emit into dist/webview/grammars/ at build time).
 * Keys are the languages CodeBlock supports after normaliseLang folds its
 * shorthands (ts/js/py/sh/shell/md); values name the `@shikijs/langs` module
 * whose registration covers them — aliases ride along on it (bash/sh/shell on
 * shellscript, docker on dockerfile).
 *
 * Never import `@shikijs/langs/*` from webview source: `inlineDynamicImports`
 * would fold the grammar straight back into the single-file bundle, which this
 * map exists to keep it out of.
 */
export const GRAMMAR_FILE: Record<string, string> = {
  typescript: "typescript",
  tsx: "tsx",
  javascript: "javascript",
  jsx: "jsx",
  python: "python",
  bash: "shellscript",
  json: "json",
  html: "html",
  css: "css",
  yaml: "yaml",
  markdown: "markdown",
  go: "go",
  rust: "rust",
  java: "java",
  sql: "sql",
  c: "c",
  cpp: "cpp",
  csharp: "csharp",
  ruby: "ruby",
  php: "php",
  swift: "swift",
  kotlin: "kotlin",
  toml: "toml",
  xml: "xml",
  docker: "dockerfile",
  dockerfile: "dockerfile",
  ini: "ini",
  diff: "diff",
}

export const GRAMMAR_FILES = [...new Set(Object.values(GRAMMAR_FILE))]
