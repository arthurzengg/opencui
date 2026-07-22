import { describe, it, expect } from "vitest"
import { findLinkRanges, findTokenRanges } from "../../webview/src/mention-tokens"

describe("findLinkRanges", () => {
  it("finds a plain https URL with exact bounds", () => {
    const text = "see https://example.com/docs for details"
    expect(findLinkRanges(text)).toEqual([
      { start: 4, end: 28, url: "https://example.com/docs" },
    ])
  })

  it("finds http and uppercase-scheme URLs", () => {
    expect(findLinkRanges("http://a.io")).toEqual([{ start: 0, end: 11, url: "http://a.io" }])
    expect(findLinkRanges("HTTPS://A.IO")).toEqual([{ start: 0, end: 12, url: "HTTPS://A.IO" }])
  })

  it("trims sentence punctuation off the end", () => {
    expect(findLinkRanges("go to https://example.com.")[0]!.url).toBe("https://example.com")
    expect(findLinkRanges("https://example.com, then...")[0]!.url).toBe("https://example.com")
    expect(findLinkRanges("really? https://example.com!?")[0]!.url).toBe("https://example.com")
    expect(findLinkRanges("<https://example.com>")[0]!.url).toBe("https://example.com")
  })

  it("trims an unbalanced closing paren but keeps a balanced one", () => {
    expect(findLinkRanges("(see https://example.com/a)")[0]!.url).toBe("https://example.com/a")
    expect(findLinkRanges("https://en.wikipedia.org/wiki/Foo_(bar)")[0]!.url).toBe(
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    )
    expect(findLinkRanges("(https://en.wikipedia.org/wiki/Foo_(bar))")[0]!.url).toBe(
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    )
  })

  it("keeps query strings and fragments intact", () => {
    expect(findLinkRanges("https://a.io/p?x=1&y=2#frag ok")[0]!.url).toBe(
      "https://a.io/p?x=1&y=2#frag",
    )
  })

  it("finds multiple URLs", () => {
    const ranges = findLinkRanges("first https://a.io then http://b.io.")
    expect(ranges.map((r) => r.url)).toEqual(["https://a.io", "http://b.io"])
  })

  it("rejects a bare scheme and matches nothing in plain prose", () => {
    expect(findLinkRanges("https:// is a scheme")).toEqual([])
    expect(findLinkRanges("https://.")).toEqual([])
    expect(findLinkRanges("no links here, not even ftp://x")).toEqual([])
  })
})

describe("findTokenRanges", () => {
  it("interleaves mention and link tokens sorted by position", () => {
    const text = "@src/foo.ts see https://example.com please"
    const ranges = findTokenRanges(text, new Set(["src/foo.ts"]))
    expect(ranges).toEqual([
      { start: 0, end: 11, kind: "mention" },
      { start: 16, end: 35, kind: "link", url: "https://example.com" },
    ])
  })

  it("keeps a URL whole when a known mention token appears inside it", () => {
    const text = "https://example.com/@src/foo.ts"
    const ranges = findTokenRanges(text, new Set(["src/foo.ts"]))
    expect(ranges).toEqual([{ start: 0, end: 31, kind: "link", url: text }])
  })

  it("keeps a chip whole when its label is itself a URL", () => {
    const label = "chat:https://example.com"
    const text = `@${label} hi`
    const ranges = findTokenRanges(text, new Set([label]))
    expect(ranges).toEqual([{ start: 0, end: 1 + label.length, kind: "mention" }])
  })

  it("returns links even with no known mentions", () => {
    const ranges = findTokenRanges("https://a.io", new Set())
    expect(ranges).toEqual([{ start: 0, end: 12, kind: "link", url: "https://a.io" }])
  })
})
