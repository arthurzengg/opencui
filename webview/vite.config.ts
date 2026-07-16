import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import { viteSingleFile } from "vite-plugin-singlefile"
import path from "node:path"

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

export default defineConfig({
  plugins: [react(), katexWoff2Only(), viteSingleFile()],
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
