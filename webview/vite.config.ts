import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import { viteSingleFile } from "vite-plugin-singlefile"
import path from "node:path"
import fs from "node:fs/promises"
import { GRAMMAR_FILES } from "./src/shiki-langs"

/**
 * KaTeX declares every font in woff2 + woff + ttf; with everything inlined
 * into the single-file bundle, that base64-encodes each font three times.
 * Every VS Code webview supports woff2, so drop the woff/ttf fallback
 * clauses from katex's CSS. Must be `enforce: "pre"`: vite:css compiles,
 * inlines, and caches the CSS in its own styles map before normal-order
 * transforms run, so a later transform never reaches the emitted output.
 */
function katexWoff2Only(): Plugin {
  return {
    name: "katex-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("katex") || !id.split("?")[0]!.endsWith(".css")) return
      return code.replace(/src:\s*([^;}]+)/g, (whole, srcs: string) => {
        const woff2 = srcs
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.includes("woff2"))
        return woff2.length ? `src:${woff2.join(",")}` : whole
      })
    },
  }
}

/**
 * Grammars are NOT bundled — `inlineDynamicImports` would fold ~2.2MB of them
 * into the single-file HTML. Instead this emits dist/webview/grammars/ for
 * the webview to fetch on demand (grammar-loader.ts): one JSON per unique
 * registration, deduped across entries (they share dependencies; per-entry
 * files would ship 5.2MB where 2.0MB suffices), plus manifest.json mapping
 * each entry to the registration names it needs. Runs on closeBundle so
 * watch-mode rebuilds re-emit.
 */
function emitGrammars(): Plugin {
  return {
    name: "emit-shiki-grammars",
    apply: "build",
    async closeBundle() {
      const dir = path.resolve(__dirname, "../dist/webview/grammars")
      await fs.mkdir(dir, { recursive: true })
      const manifest: Record<string, string[]> = {}
      const written = new Set<string>()
      for (const file of GRAMMAR_FILES) {
        const mod = await import(`@shikijs/langs/${file}`)
        const names: string[] = []
        for (const reg of mod.default as Array<{ name: string }>) {
          // Registration names become fetch paths; "manifest" would collide.
          if (!/^[\w-]+$/.test(reg.name) || reg.name === "manifest") {
            throw new Error(`unsafe grammar registration name: ${reg.name}`)
          }
          if (!names.includes(reg.name)) names.push(reg.name)
          if (!written.has(reg.name)) {
            written.add(reg.name)
            await fs.writeFile(path.join(dir, `${reg.name}.json`), JSON.stringify(reg))
          }
        }
        manifest[file] = names
      }
      await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest))
    },
  }
}

export default defineConfig({
  plugins: [react(), katexWoff2Only(), viteSingleFile(), emitGrammars()],
  build: {
    outDir: path.resolve(__dirname, "../dist/webview"),
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
