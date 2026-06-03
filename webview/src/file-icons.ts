/**
 * Map a file name to a codicon class *suffix* for the @-picker file rows
 * (callers prepend "codicon-"). Monochrome, theme-colored category icons:
 * VS Code's colorful per-language icons come from the active file icon theme,
 * which a webview cannot read, so we ship our own category-level set that
 * matches the `codicon-folder` already used in the same picker.
 */

const BY_EXT: Record<string, string> = {
  // Source / markup / styles — one generic "code file" glyph
  ts: "file-code", tsx: "file-code", js: "file-code", jsx: "file-code",
  mjs: "file-code", cjs: "file-code", mts: "file-code", cts: "file-code",
  html: "file-code", htm: "file-code", xml: "file-code", vue: "file-code",
  svelte: "file-code", astro: "file-code",
  css: "file-code", scss: "file-code", sass: "file-code", less: "file-code",
  py: "file-code", rb: "file-code", go: "file-code", rs: "file-code",
  java: "file-code", kt: "file-code", c: "file-code", h: "file-code",
  cpp: "file-code", cc: "file-code", hpp: "file-code", cs: "file-code",
  php: "file-code", swift: "file-code", lua: "file-code", dart: "file-code",
  // Structured data
  json: "json", jsonc: "json",
  // Docs / text
  md: "markdown", mdx: "markdown", markdown: "markdown",
  txt: "file-text", rst: "file-text", log: "file-text",
  pdf: "file-pdf",
  // Config formats
  yaml: "gear", yml: "gear", toml: "gear", ini: "gear", env: "gear",
  conf: "gear", cfg: "gear", properties: "gear",
  // Images / media
  png: "file-media", jpg: "file-media", jpeg: "file-media", gif: "file-media",
  webp: "file-media", bmp: "file-media", ico: "file-media", svg: "file-media",
  avif: "file-media", mp4: "file-media", mov: "file-media", webm: "file-media",
  mp3: "file-media", wav: "file-media",
  // Archives
  zip: "file-zip", tar: "file-zip", gz: "file-zip", tgz: "file-zip",
  rar: "file-zip", "7z": "file-zip", bz2: "file-zip",
  // Compiled / binary
  exe: "file-binary", bin: "file-binary", so: "file-binary", dll: "file-binary",
  o: "file-binary", a: "file-binary", wasm: "file-binary", dylib: "file-binary",
  // Databases
  db: "database", sqlite: "database", sql: "database",
  // Shell scripts
  sh: "terminal", bash: "terminal", zsh: "terminal", fish: "terminal",
  // Notebooks
  ipynb: "notebook",
}

export function fileTypeCodicon(name: string): string {
  const lower = name.toLowerCase()
  // Lock files often carry a .json/.yaml extension we'd otherwise classify by
  // (package-lock.json, pnpm-lock.yaml, bun.lock, Cargo.lock), so match first.
  if (lower.endsWith(".lock") || lower === "package-lock.json" || lower === "pnpm-lock.yaml") return "lock"
  if (
    lower === "license" ||
    lower === "licence" ||
    lower.startsWith("license.") ||
    lower.startsWith("licence.")
  )
    return "law"
  // `lastIndexOf(".") + 1` gives the whole name when there is no dot (-1 + 1 =
  // 0), and the part after the leading dot for dotfiles (".env" -> "env"). Both
  // fall through to the `?? "file"` fallback when unmatched (".gitignore").
  const ext = lower.slice(lower.lastIndexOf(".") + 1)
  return BY_EXT[ext] ?? "file"
}
