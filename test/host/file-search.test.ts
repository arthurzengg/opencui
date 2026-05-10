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
})
