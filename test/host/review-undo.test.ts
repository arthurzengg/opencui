import { describe, it, expect } from "vitest"
import {
  findHunkInFile,
  parseHunkHeader,
  splitReviewDiff,
} from "../../src/chat/diff"

describe("parseHunkHeader", () => {
  it("parses @@ -X,Y +A,B @@", () => {
    expect(parseHunkHeader("@@ -3,5 +3,3 @@")).toEqual({
      oldStart: 3,
      oldCount: 5,
      newStart: 3,
      newCount: 3,
    })
  })

  it("defaults missing counts to 1 (per unified diff spec)", () => {
    expect(parseHunkHeader("@@ -7 +9 @@")).toEqual({
      oldStart: 7,
      oldCount: 1,
      newStart: 9,
      newCount: 1,
    })
  })

  it("parses created-file hunk (@@ -0,0 +1,N @@)", () => {
    expect(parseHunkHeader("@@ -0,0 +1,3 @@")).toEqual({
      oldStart: 0,
      oldCount: 0,
      newStart: 1,
      newCount: 3,
    })
  })

  it("parses deleted-file hunk (@@ -1,N +0,0 @@)", () => {
    expect(parseHunkHeader("@@ -1,4 +0,0 @@")).toEqual({
      oldStart: 1,
      oldCount: 4,
      newStart: 0,
      newCount: 0,
    })
  })

  it("returns undefined for malformed headers", () => {
    expect(parseHunkHeader("@@ broken @@")).toBeUndefined()
    expect(parseHunkHeader("not a hunk header")).toBeUndefined()
  })
})

describe("splitReviewDiff: hunk header line numbers", () => {
  it("attaches oldStart/oldCount/newStart/newCount per hunk", () => {
    const patch = [
      "@@ -1,2 +1,3 @@",
      " ctx",
      "+added",
      " ctx2",
      "@@ -10,3 +11,4 @@",
      " ctx3",
      "+added2",
      " ctx4",
      " ctx5",
    ].join("\n")
    const hunks = splitReviewDiff(patch).hunks
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldCount: 2, newStart: 1, newCount: 3 })
    expect(hunks[1]).toMatchObject({ oldStart: 10, oldCount: 3, newStart: 11, newCount: 4 })
  })

  it("flags hunks without a parseable header as non-reversible", () => {
    const patch = "no @@ here\njust text"
    const hunks = splitReviewDiff(patch).hunks
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.reversible).toBe(false)
  })

  it("captures leading + trailing context lines per hunk", () => {
    const patch = [
      "@@ -1,5 +1,5 @@",
      " context_before_1",
      " context_before_2",
      "-deleted_line",
      "+added_line",
      " context_after_1",
      " context_after_2",
    ].join("\n")
    const hunk = splitReviewDiff(patch).hunks[0]!
    expect(hunk.leadingContext).toEqual(["context_before_1", "context_before_2"])
    expect(hunk.trailingContext).toEqual(["context_after_1", "context_after_2"])
  })
})

describe("findHunkInFile: safe location for repeated text blocks", () => {
  it("uses newStart line to disambiguate identical blocks", () => {
    // Two identical blocks at different line offsets. The hunk header
    // pinpoints the SECOND occurrence (line 4); the legacy indexOf-based
    // approach would have located the FIRST.
    const file = ["alpha", "beta", "gamma", "alpha", "beta", "gamma"].join("\n")
    const result = findHunkInFile(file, {
      newText: "alpha\nbeta\ngamma",
      newStart: 4,
      newCount: 3,
      leadingContext: [],
      trailingContext: [],
    })
    expect(result).toBeDefined()
    expect(result!.start).toBe(file.indexOf("alpha", 1))
    expect(file.slice(result!.start, result!.end)).toBe("alpha\nbeta\ngamma")
  })

  it("returns undefined when the same text appears multiple times and newStart cannot anchor", () => {
    const file = "foo\nbar\nfoo\nbar"
    const result = findHunkInFile(file, {
      newText: "foo",
      newStart: 0, // unknown line — falls through to unique substring
      newCount: 1,
      leadingContext: [],
      trailingContext: [],
    })
    expect(result).toBeUndefined()
  })

  it("locates a single unique block via the substring fallback", () => {
    const file = "header\nbody1\nbody2\nfooter"
    const result = findHunkInFile(file, {
      newText: "body1\nbody2",
      newStart: 0,
      newCount: 2,
      leadingContext: [],
      trailingContext: [],
    })
    expect(result).toBeDefined()
    expect(file.slice(result!.start, result!.end)).toBe("body1\nbody2")
  })

  it("returns undefined when the new text isn't present at all", () => {
    const file = "alpha\nbeta"
    const result = findHunkInFile(file, {
      newText: "gamma",
      newStart: 0,
      newCount: 1,
      leadingContext: [],
      trailingContext: [],
    })
    expect(result).toBeUndefined()
  })

  it("handles a hunk that was just appended at the end of the file", () => {
    const file = "line1\nline2\nappended"
    const result = findHunkInFile(file, {
      newText: "appended",
      newStart: 3,
      newCount: 1,
      leadingContext: [],
      trailingContext: [],
    })
    expect(result).toBeDefined()
    expect(file.slice(result!.start, result!.end)).toBe("appended")
  })

  it("is tolerant of trailing-newline drift between diff and file", () => {
    const file = "line1\nline2\n"
    const result = findHunkInFile(file, {
      newText: "line2",
      newStart: 2,
      newCount: 1,
      leadingContext: [],
      trailingContext: [],
    })
    expect(result).toBeDefined()
  })
})

describe("splitReviewDiff round-trip with findHunkInFile", () => {
  it("locates each hunk of a multi-hunk diff at its true offset, not at the FIRST match", () => {
    // Build a fake file with two adjacent identical-ish sections. Both
    // sections contain the literal substring "do_thing()" — naive indexOf
    // would always point at the first one.
    const file = [
      "function a() {",
      "  do_thing()",
      "}",
      "",
      "function b() {",
      "  do_thing()",
      "}",
    ].join("\n")
    // Diff that targets ONLY the b() copy (line 6 in 1-based numbering).
    const patch = [
      "@@ -5,3 +5,3 @@",
      " function b() {",
      "-  do_thing()",
      "+  do_other_thing()",
      " }",
    ].join("\n")
    const hunk = splitReviewDiff(patch).hunks[0]!
    // Simulate the file AFTER the edit (b's body changed).
    const afterEdit = [
      "function a() {",
      "  do_thing()",
      "}",
      "",
      "function b() {",
      "  do_other_thing()",
      "}",
    ].join("\n")
    const result = findHunkInFile(afterEdit, hunk)
    expect(result).toBeDefined()
    // It must point at the b() copy, not a().
    expect(afterEdit.slice(result!.start, result!.end)).toBe("function b() {\n  do_other_thing()\n}")
  })
})
