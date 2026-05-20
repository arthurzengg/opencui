import { describe, it, expect } from "vitest"
import { chunkText } from "../../src/indexing/chunker"
import { defaultIgnoreMatcher, IgnoreMatcher } from "../../src/indexing/ignore"
import { MemoryVectorStore } from "../../src/indexing/vector-store"
import { hybridSearch } from "../../src/indexing/search"
import { NoneProvider, createEmbeddingProvider, SemanticIndexingDisabledError } from "../../src/indexing/embedding-provider"
import { readIndexSettings, DEFAULT_INDEX_SETTINGS } from "../../src/indexing/index-manager"
import type { EmbeddingProvider, IndexedChunk } from "../../src/indexing/types"

describe("chunkText", () => {
  it("returns a single chunk for a small file", () => {
    const text = "line1\nline2\nline3"
    const chunks = chunkText("foo.ts", text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 3 })
    expect(chunks[0].text).toBe(text)
    expect(chunks[0].hash.length).toBeGreaterThan(0)
  })

  it("produces overlapping windows for a large file", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`)
    const text = lines.join("\n")
    const chunks = chunkText("big.ts", text, { window: 60, step: 40 })
    expect(chunks.length).toBeGreaterThan(1)
    // First and second chunks overlap (step < window).
    expect(chunks[0].endLine).toBeGreaterThan(chunks[1].startLine)
    expect(chunks[chunks.length - 1].endLine).toBe(200)
  })
})

describe("IgnoreMatcher", () => {
  const matcher = defaultIgnoreMatcher()

  it("excludes node_modules", () => {
    expect(matcher.match("node_modules/foo/index.js")).toBe(true)
    expect(matcher.match("src/node_modules/x.ts")).toBe(true)
  })

  it("excludes lockfiles and minified bundles", () => {
    expect(matcher.match("bun.lockb")).toBe(true)
    expect(matcher.match("package-lock.json")).toBe(false) // not in pattern list (only *.lock)
    expect(matcher.match("dist/app.min.js")).toBe(true)
  })

  it("excludes secret-like filenames at any depth", () => {
    expect(matcher.match(".env")).toBe(true)
    expect(matcher.match(".env.local")).toBe(true)
    expect(matcher.match("server/keys/private.pem")).toBe(true)
  })

  it("respects negation patterns", () => {
    const m = new IgnoreMatcher(["dist/", "!dist/keep.json"])
    expect(m.match("dist/app.js")).toBe(true)
    expect(m.match("dist/keep.json")).toBe(false)
  })

  it("does not exclude regular workspace files", () => {
    expect(matcher.match("src/index.ts")).toBe(false)
    expect(matcher.match("README.md")).toBe(false)
  })
})

describe("NoneProvider", () => {
  it("throws SemanticIndexingDisabledError on embed", async () => {
    const p = new NoneProvider()
    await expect(p.embed(["q"])).rejects.toBeInstanceOf(SemanticIndexingDisabledError)
  })

  it("createEmbeddingProvider falls back to NoneProvider for stub provider ids", () => {
    expect(createEmbeddingProvider("none").id).toBe("none")
    expect(createEmbeddingProvider("openai").id).toBe("none") // stubbed in Phase 6
  })
})

describe("MemoryVectorStore", () => {
  function chunk(id: string, path: string, text: string, symbols: string[] = []): IndexedChunk {
    return {
      id,
      root: "/repo",
      path,
      startLine: 1,
      endLine: text.split("\n").length,
      text,
      hash: id,
      symbols,
      updatedAt: 0,
    }
  }

  it("upsert + textSearch finds matches by text", async () => {
    const s = new MemoryVectorStore()
    await s.open()
    await s.upsert([chunk("c1", "src/a.ts", "the quick brown fox")])
    const hits = await s.textSearch("quick", { limit: 5 })
    expect(hits).toHaveLength(1)
    expect(hits[0].chunkID).toBe("c1")
    expect(hits[0].reasons).toContain("text-match")
  })

  it("ranks path matches above symbol-only matches", async () => {
    const s = new MemoryVectorStore()
    await s.open()
    await s.upsert([
      chunk("c1", "src/parser.ts", "no relevant text here", ["unrelated"]),
      chunk("c2", "src/other.ts", "no relevant text here", ["parser"]),
    ])
    const hits = await s.textSearch("parser", { limit: 5 })
    expect(hits).toHaveLength(2)
    // c1 wins via path-match (0.6) + text-match (0); c2 has only symbol-match (0.5).
    expect(hits[0].chunkID).toBe("c1")
  })

  it("filters by root option", async () => {
    const s = new MemoryVectorStore()
    await s.open()
    await s.upsert([
      chunk("c1", "src/a.ts", "hello"),
      { ...chunk("c2", "src/b.ts", "hello"), root: "/other" },
    ])
    const hits = await s.textSearch("hello", { root: "/repo" })
    expect(hits.map((h) => h.chunkID)).toEqual(["c1"])
  })

  it("deleteByPath removes chunks for a given (root, path)", async () => {
    const s = new MemoryVectorStore()
    await s.open()
    await s.upsert([chunk("c1", "src/a.ts", "x"), chunk("c2", "src/b.ts", "x")])
    await s.deleteByPath("/repo", "src/a.ts")
    expect(await s.size()).toBe(1)
  })
})

describe("hybridSearch", () => {
  function chunk(id: string, text: string, embedding?: Float32Array): IndexedChunk {
    return {
      id,
      root: "/repo",
      path: `${id}.ts`,
      startLine: 1,
      endLine: 1,
      text,
      hash: id,
      symbols: [],
      embedding,
      updatedAt: 0,
    }
  }

  it("falls back to text-only search when the provider is `none`", async () => {
    const store = new MemoryVectorStore()
    await store.open()
    await store.upsert([chunk("c1", "fox")])
    const hits = await hybridSearch("fox", store, new NoneProvider(), { limit: 5 })
    expect(hits.map((h) => h.chunkID)).toEqual(["c1"])
  })

  it("falls back gracefully when a real provider throws disabled", async () => {
    const store = new MemoryVectorStore()
    await store.open()
    await store.upsert([chunk("c1", "fox")])
    const throwy: EmbeddingProvider = {
      id: "openai",
      dimensions: 3,
      embed: () => Promise.reject(new SemanticIndexingDisabledError()),
    }
    const hits = await hybridSearch("fox", store, throwy, { limit: 5 })
    expect(hits.map((h) => h.chunkID)).toEqual(["c1"])
  })
})

describe("readIndexSettings", () => {
  it("returns defaults when no keys are set", () => {
    const cfg = { get: <T>(_k: string): T | undefined => undefined }
    expect(readIndexSettings(cfg)).toEqual(DEFAULT_INDEX_SETTINGS)
  })

  it("respects per-key overrides", () => {
    const cfg = {
      get<T>(key: string): T | undefined {
        if (key === "indexing.semantic.enabled") return true as unknown as T
        if (key === "indexing.semantic.provider") return "openai" as unknown as T
        if (key === "indexing.maxFiles") return 1000 as unknown as T
        return undefined
      },
    }
    const s = readIndexSettings(cfg)
    expect(s.enabled).toBe(true)
    expect(s.providerID).toBe("openai")
    expect(s.maxFiles).toBe(1000)
    expect(s.maxFileBytes).toBe(DEFAULT_INDEX_SETTINGS.maxFileBytes)
  })
})
