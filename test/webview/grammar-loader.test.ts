import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

/**
 * The loader keeps module-level caches (manifest + per-registration fetches),
 * so each test re-imports a fresh copy via resetModules.
 */
const MANIFEST = {
  html: ["javascript", "css", "html"],
  javascript: ["javascript"],
}

function reg(name: string) {
  return { name, scopeName: `source.${name}`, patterns: [] }
}

let failing: Set<string>
const fetchMock = vi.fn(async (url: string) => {
  const name = url.split("/").at(-1)!.replace(/\.json$/, "")
  if (failing.has(name)) return { ok: false, status: 500 } as Response
  const body = name === "manifest" ? MANIFEST : reg(name)
  return { ok: true, json: async () => body } as unknown as Response
})

async function freshLoader() {
  vi.resetModules()
  return await import("../../webview/src/grammar-loader")
}

function fetchesOf(name: string) {
  return fetchMock.mock.calls.filter(([url]) => url.endsWith(`/${name}.json`)).length
}

beforeEach(() => {
  failing = new Set()
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
  window.__opencuiGrammarsBase = "https://webview.test/grammars"
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete window.__opencuiGrammarsBase
})

describe("loadGrammar", () => {
  it("rejects when the host did not inject the base URI", async () => {
    delete window.__opencuiGrammarsBase
    const { loadGrammar } = await freshLoader()
    await expect(loadGrammar("html")).rejects.toThrow(/not injected/)
  })

  it("returns the entry's registrations in manifest order", async () => {
    const { loadGrammar } = await freshLoader()
    const regs = await loadGrammar("html")
    expect(regs.map((r) => r.name)).toEqual(["javascript", "css", "html"])
  })

  it("fetches the manifest once and shares registrations across entries", async () => {
    const { loadGrammar } = await freshLoader()
    await loadGrammar("html")
    await loadGrammar("javascript")
    expect(fetchesOf("manifest")).toBe(1)
    // javascript already came in with html's dependency set.
    expect(fetchesOf("javascript")).toBe(1)
  })

  it("rejects an entry the manifest does not know", async () => {
    const { loadGrammar } = await freshLoader()
    await expect(loadGrammar("cobol")).rejects.toThrow(/not in manifest/)
  })

  it("evicts a failed registration fetch so the next attempt retries it alone", async () => {
    const { loadGrammar } = await freshLoader()
    failing.add("css")
    await expect(loadGrammar("html")).rejects.toThrow(/css: HTTP 500/)
    failing.delete("css")
    const regs = await loadGrammar("html")
    expect(regs.map((r) => r.name)).toEqual(["javascript", "css", "html"])
    // Only the failed fetch re-ran; its successful siblings stayed cached.
    expect(fetchesOf("css")).toBe(2)
    expect(fetchesOf("javascript")).toBe(1)
    expect(fetchesOf("html")).toBe(1)
  })

  it("evicts a failed manifest fetch", async () => {
    const { loadGrammar } = await freshLoader()
    failing.add("manifest")
    await expect(loadGrammar("html")).rejects.toThrow(/manifest: HTTP 500/)
    failing.delete("manifest")
    await expect(loadGrammar("html")).resolves.toHaveLength(3)
    expect(fetchesOf("manifest")).toBe(2)
  })
})
