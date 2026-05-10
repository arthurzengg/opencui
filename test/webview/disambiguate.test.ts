import { describe, it, expect } from "vitest"
import { disambiguatePaths, shortestUniqueSuffix } from "../../webview/src/components/ReviewPanel"

describe("disambiguatePaths", () => {
  it("returns basename for unique paths", () => {
    const result = disambiguatePaths(["foo.ts", "bar.ts", "baz.ts"])
    expect(result.get("foo.ts")).toBe("foo.ts")
    expect(result.get("bar.ts")).toBe("bar.ts")
    expect(result.get("baz.ts")).toBe("baz.ts")
  })

  it("disambiguates same-basename paths with one parent", () => {
    const result = disambiguatePaths(["views/index.ts", "admin/index.ts"])
    expect(result.get("views/index.ts")).toBe("views/index.ts")
    expect(result.get("admin/index.ts")).toBe("admin/index.ts")
  })

  it("disambiguates with multiple parent levels when needed", () => {
    const result = disambiguatePaths([
      "a/views/index.ts",
      "b/views/index.ts",
      "c/views/index.ts",
    ])
    expect(result.get("a/views/index.ts")).toBe("a/views/index.ts")
    expect(result.get("b/views/index.ts")).toBe("b/views/index.ts")
    expect(result.get("c/views/index.ts")).toBe("c/views/index.ts")
  })

  it("handles a deep path with no collision", () => {
    const result = disambiguatePaths(["src/components/Button/index.ts"])
    expect(result.get("src/components/Button/index.ts")).toBe("index.ts")
  })

  it("mixes unique and colliding paths", () => {
    const result = disambiguatePaths([
      "src/utils/helpers.ts",
      "src/components/index.ts",
      "src/views/index.ts",
    ])
    expect(result.get("src/utils/helpers.ts")).toBe("helpers.ts")
    expect(result.get("src/components/index.ts")).toBe("components/index.ts")
    expect(result.get("src/views/index.ts")).toBe("views/index.ts")
  })

  it("handles empty input", () => {
    const result = disambiguatePaths([])
    expect(result.size).toBe(0)
  })
})

describe("shortestUniqueSuffix", () => {
  it("returns basename if no collision", () => {
    expect(shortestUniqueSuffix("src/foo.ts", ["src/bar.ts"])).toBe("foo.ts")
  })

  it("adds parents progressively until unique", () => {
    expect(shortestUniqueSuffix("a/b/c.ts", ["d/b/c.ts"])).toBe("a/b/c.ts")
  })

  it("returns basename when target is the only entry (self-collision excluded)", () => {
    const result = shortestUniqueSuffix("foo/bar.ts", ["foo/bar.ts"])
    expect(result).toBe("bar.ts")
  })
})
