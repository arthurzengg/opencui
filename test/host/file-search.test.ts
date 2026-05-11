import { describe, it, expect } from "vitest"
import { rankHits } from "../../src/file-search"

const fixtures = [
  { path: "src/foo.ts", name: "foo.ts" },
  { path: "src/foo/index.ts", name: "index.ts" },
  { path: "src/bar/foo.tsx", name: "foo.tsx" },
  { path: "lib/utils/foo-bar.ts", name: "foo-bar.ts" },
  { path: "src/bar.ts", name: "bar.ts" },
  { path: "deep/very/long/path/to/baz.ts", name: "baz.ts" },
]

describe("rankHits", () => {
  it("returns the input order for an empty query (capped)", () => {
    const out = rankHits(fixtures, "")
    expect(out.map((h) => h.path)).toEqual(fixtures.map((h) => h.path))
  })

  it("ranks exact basename match first", () => {
    const out = rankHits(fixtures, "foo.ts")
    expect(out[0]?.path).toBe("src/foo.ts")
  })

  it("ranks basename prefix match before substring matches", () => {
    const out = rankHits(fixtures, "foo")
    // "foo.ts" and "foo.tsx" and "foo-bar.ts" all start with foo
    const prefixOrder = out.slice(0, 3).map((h) => h.name)
    expect(prefixOrder).toContain("foo.ts")
    expect(prefixOrder).toContain("foo.tsx")
    expect(prefixOrder).toContain("foo-bar.ts")
    // index.ts (path contains foo but basename doesn't start with foo) comes later
    const indexIdx = out.findIndex((h) => h.path === "src/foo/index.ts")
    expect(indexIdx).toBeGreaterThan(2)
  })

  it("falls back to path substring match", () => {
    const out = rankHits(fixtures, "deep/very")
    expect(out[0]?.path).toBe("deep/very/long/path/to/baz.ts")
  })

  it("breaks ties by shorter path", () => {
    const entries = [
      { path: "a/very/long/path/foo.ts", name: "foo.ts" },
      { path: "x/foo.ts", name: "foo.ts" },
    ]
    const out = rankHits(entries, "foo.ts")
    expect(out[0]?.path).toBe("x/foo.ts")
  })

  it("excludes entries that don't match the query at all", () => {
    const out = rankHits(fixtures, "xyz-not-found")
    expect(out).toEqual([])
  })

  it("is case-insensitive", () => {
    const out = rankHits(fixtures, "FOO")
    expect(out.length).toBeGreaterThan(0)
    expect(out[0]?.name.toLowerCase()).toContain("foo")
  })

  it("handles whitespace-only query as empty", () => {
    const out = rankHits(fixtures, "   ")
    expect(out.map((h) => h.path)).toEqual(fixtures.map((h) => h.path))
  })

  describe("recent-tabs boost", () => {
    it("empty query: recently-opened paths sort to the top in tab order", () => {
      const out = rankHits(fixtures, "", ["deep/very/long/path/to/baz.ts", "src/bar.ts"])
      expect(out[0]?.path).toBe("deep/very/long/path/to/baz.ts")
      expect(out[1]?.path).toBe("src/bar.ts")
    })

    it("non-empty query: within the same score tier, recent files come first", () => {
      const entries = [
        { path: "lib/foo.ts", name: "foo.ts" },
        { path: "src/foo.ts", name: "foo.ts" },
      ]
      // Both are exact-basename matches → same score tier. Without recent, the
      // shorter path wins. With recent, the recent one wins regardless of length.
      const out = rankHits(entries, "foo.ts", ["lib/foo.ts"])
      expect(out[0]?.path).toBe("lib/foo.ts")
    })

    it("recent files that don't match the query are NOT included", () => {
      const out = rankHits(fixtures, "baz", ["src/foo.ts"])
      // "src/foo.ts" doesn't match query "baz" → excluded despite being recent
      expect(out.every((h) => h.path !== "src/foo.ts")).toBe(true)
      expect(out[0]?.path).toBe("deep/very/long/path/to/baz.ts")
    })

    it("recency only re-orders within a score tier — higher tiers still beat recent", () => {
      const entries = [
        { path: "a/foo.ts", name: "foo.ts" }, // exact basename match, NOT recent
        { path: "b/foo-bar.ts", name: "foo-bar.ts" }, // basename prefix match, IS recent
      ]
      const out = rankHits(entries, "foo.ts", ["b/foo-bar.ts"])
      // Even though foo-bar.ts is recent, foo.ts has the better score tier.
      expect(out[0]?.path).toBe("a/foo.ts")
    })

    it("duplicate recent entries are deduped to their first index", () => {
      const out = rankHits(fixtures, "", ["src/foo.ts", "src/foo.ts", "src/bar.ts"])
      expect(out[0]?.path).toBe("src/foo.ts")
      expect(out[1]?.path).toBe("src/bar.ts")
    })
  })
})
