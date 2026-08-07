import { describe, it, expect } from "vitest"
import { GRAMMAR_FILE, GRAMMAR_FILES } from "../../webview/src/shiki-langs"

// Resolved by path because @shikijs/langs lives in webview/node_modules,
// which bare specifiers in this test tree do not reach.
type Registration = { name: string; aliases?: string[] }
async function loadEntry(file: string): Promise<Registration[]> {
  const mod = await import(`../../webview/node_modules/@shikijs/langs/dist/${file}.mjs`)
  return mod.default
}

describe("shiki-langs map vs the real grammar set", () => {
  it("every mapped language is registered by its entry, as a name or alias", async () => {
    // Pins shiki upgrades: if a grammar drops an alias this map relies on
    // (bash on shellscript, docker on dockerfile), the fetch would succeed
    // but codeToHtml would throw on the unknown language.
    for (const file of GRAMMAR_FILES) {
      const regs = await loadEntry(file)
      const known = new Set(regs.flatMap((r) => [r.name, ...(r.aliases ?? [])]))
      for (const [lang, mapped] of Object.entries(GRAMMAR_FILE)) {
        if (mapped !== file) continue
        expect(known.has(lang), `"${lang}" is not registered by @shikijs/langs/${file}`).toBe(true)
      }
    }
  })

  it("registration names are usable as fetch paths and never collide with the manifest", async () => {
    // Mirrors the build-time guard in vite.config.ts's emitGrammars.
    for (const file of GRAMMAR_FILES) {
      for (const { name } of await loadEntry(file)) {
        expect(name).toMatch(/^[\w-]+$/)
        expect(name).not.toBe("manifest")
      }
    }
  })
})
