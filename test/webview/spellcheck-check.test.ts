import { describe, it, expect } from "vitest"
import { findMisspellingAt, findMisspellings, tokenizeWords } from "../../webview/src/spellcheck/check"

const NEVER_CORRECT = () => false
const ALWAYS_CORRECT = () => true

describe("tokenizeWords", () => {
  it("splits plain prose into word ranges", () => {
    const words = tokenizeWords("Hello there friend", [])
    expect(words.map((w) => w.word)).toEqual(["Hello", "there", "friend"])
    expect(words[0]).toEqual({ start: 0, end: 5, word: "Hello" })
    expect(words[1]).toEqual({ start: 6, end: 11, word: "there" })
  })

  it("keeps contractions intact", () => {
    const words = tokenizeWords("don't worry it's fine", [])
    expect(words.map((w) => w.word)).toEqual(["don't", "worry", "it's", "fine"])
  })

  it("drops tokens shorter than 3 characters", () => {
    const words = tokenizeWords("a is so", [])
    expect(words).toEqual([])
  })

  it("skips URLs entirely", () => {
    const words = tokenizeWords("see https://example.com/foo for details", [])
    expect(words.map((w) => w.word)).toEqual(["see", "for", "details"])
  })

  it("skips identifier-like tokens (digits, dots, underscores, slashes)", () => {
    const words = tokenizeWords(
      "the renderHighlightedText helper in src/foo_bar.ts version 2.0",
      [],
    )
    // "the", "helper", "in", "version" are prose. The others are mixed-case
    // identifiers, path segments, or numeric tokens we don't want to flag.
    expect(words.map((w) => w.word)).toEqual(["the", "helper", "version"])
  })

  it("skips words inside mention ranges", () => {
    // Layout: "hello @src/foo.ts world"
    //         0     6                22
    const text = "hello @src/foo.ts world"
    const mentionStart = text.indexOf("@")
    const mentionEnd = text.indexOf(" ", mentionStart)
    const words = tokenizeWords(text, [{ start: mentionStart, end: mentionEnd }])
    expect(words.map((w) => w.word)).toEqual(["hello", "world"])
  })
})

describe("findMisspellings", () => {
  it("returns only words the dictionary rejects", () => {
    const text = "the cat sat"
    const yes = (w: string) => w !== "cat"
    expect(findMisspellings(text, [], yes).map((m) => m.word)).toEqual(["cat"])
  })

  it("returns no misspellings when everything is correct", () => {
    expect(findMisspellings("the cat sat", [], ALWAYS_CORRECT)).toEqual([])
  })

  it("returns positional info that tracks the original string", () => {
    const text = "the helo there"
    const yes = (w: string) => w !== "helo"
    const found = findMisspellings(text, [], yes)
    expect(found).toHaveLength(1)
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe("helo")
  })

  it("skips misspellings that live inside a mention chip", () => {
    const text = "look @badspeled.ts here"
    const mention = { start: text.indexOf("@"), end: text.indexOf(" ", text.indexOf("@")) }
    // Even if everything is flagged misspelled, mention contents must not be reported.
    expect(findMisspellings(text, [mention], NEVER_CORRECT).map((w) => w.word)).toEqual([
      "look",
      "here",
    ])
  })
})

describe("findMisspellingAt", () => {
  const ranges = [
    { start: 4, end: 8, word: "helo" },
    { start: 14, end: 20, word: "frined" },
  ]

  it("locates the word that contains the caret", () => {
    expect(findMisspellingAt(6, ranges)?.word).toBe("helo")
    expect(findMisspellingAt(16, ranges)?.word).toBe("frined")
  })

  it("matches the boundary positions (start and end)", () => {
    expect(findMisspellingAt(4, ranges)?.word).toBe("helo")
    expect(findMisspellingAt(8, ranges)?.word).toBe("helo")
  })

  it("returns null when the caret is outside any misspelling", () => {
    expect(findMisspellingAt(0, ranges)).toBeNull()
    expect(findMisspellingAt(10, ranges)).toBeNull()
    expect(findMisspellingAt(100, ranges)).toBeNull()
  })
})
