import { describe, it, expect } from "vitest"
import {
  samePath,
  normalizePath,
  isTextReviewPath,
  patchKind,
  patchPath,
  countDiff,
  unique,
  isRecord,
  escapeHtml,
  findHunkText,
  splitReviewDiff,
  reviewLineText,
  firstReviewAnchor,
  firstChangedBlock,
  reviewKey,
  diffLines,
  synthesizeCreatePatch,
} from "../../src/chat/view"

describe("samePath / normalizePath", () => {
  it("compares identical paths", () => {
    expect(samePath("foo/bar.ts", "foo/bar.ts")).toBe(true)
  })

  it("normalizes backslashes", () => {
    expect(normalizePath("foo\\bar.ts")).toBe("foo/bar.ts")
  })

  it("strips leading ./", () => {
    expect(normalizePath("./foo.ts")).toBe("foo.ts")
  })

  it("returns false for undefined right", () => {
    expect(samePath("a", undefined)).toBe(false)
  })
})

describe("isTextReviewPath", () => {
  it("accepts standard source files", () => {
    expect(isTextReviewPath("src/index.ts")).toBe(true)
    expect(isTextReviewPath("README.md")).toBe(true)
    expect(isTextReviewPath("config.yaml")).toBe(true)
  })

  it("rejects binary extensions", () => {
    expect(isTextReviewPath("logo.png")).toBe(false)
    expect(isTextReviewPath("clip.mp4")).toBe(false)
    expect(isTextReviewPath("dump.bin")).toBe(false)
    expect(isTextReviewPath("archive.zip")).toBe(false)
  })

  it("rejects .DS_Store / Thumbs.db", () => {
    expect(isTextReviewPath(".DS_Store")).toBe(false)
    expect(isTextReviewPath("Thumbs.db")).toBe(false)
  })

  it("accepts dotfiles with extensions", () => {
    expect(isTextReviewPath(".eslintrc.json")).toBe(true)
  })

  it("rejects extensionless dotfiles", () => {
    expect(isTextReviewPath(".nonexistent")).toBe(false)
  })
})

describe("patchKind", () => {
  it("maps add → created, delete → deleted, move → moved, default → updated", () => {
    expect(patchKind("add")).toBe("created")
    expect(patchKind("delete")).toBe("deleted")
    expect(patchKind("move")).toBe("moved")
    expect(patchKind("modify")).toBe("updated")
    expect(patchKind(undefined)).toBe("updated")
  })
})

describe("patchPath", () => {
  it("extracts +++ b/path target", () => {
    const patch = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@\n+x"
    expect(patchPath(patch)).toBe("foo.ts")
  })

  it("falls back to --- a/path when +++ is /dev/null (deletion)", () => {
    const patch = "--- a/old.ts\n+++ /dev/null\n@@\n-x"
    expect(patchPath(patch)).toBe("old.ts")
  })

  it("falls back to Index: header", () => {
    const patch = "Index: legacy.ts\n@@\n+x"
    expect(patchPath(patch)).toBe("legacy.ts")
  })

  it("returns 'file' as last resort", () => {
    expect(patchPath("@@ -1 +1 @@\n+x")).toBe("file")
  })
})

describe("countDiff", () => {
  it("counts only real +/- lines, not file headers", () => {
    const patch = "+++ b/file\n--- a/file\n@@\n+real\n-real\n context"
    expect(countDiff(patch, "+")).toBe(1)
    expect(countDiff(patch, "-")).toBe(1)
  })
})

describe("unique / isRecord", () => {
  it("dedupes preserving order", () => {
    expect(unique(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"])
  })

  it("isRecord rejects null and primitives", () => {
    expect(isRecord(null)).toBe(false)
    expect(isRecord("x")).toBe(false)
    expect(isRecord(42)).toBe(false)
    expect(isRecord({})).toBe(true)
  })
})

describe("escapeHtml", () => {
  it("escapes &, <, >, and double quotes (single quotes pass through)", () => {
    expect(escapeHtml(`<script>alert("y" & x)</script>`)).toBe(
      "&lt;script&gt;alert(&quot;y&quot; &amp; x)&lt;/script&gt;",
    )
  })
})

describe("findHunkText", () => {
  it("locates a substring in the document", () => {
    const doc = "line1\nline2\nline3"
    const result = findHunkText(doc, "line2")
    expect(result).toEqual({ start: 6, end: 11 })
  })

  it("tries with/without trailing newline", () => {
    const doc = "alpha\nbeta\ngamma"
    const result = findHunkText(doc, "alpha\n")
    expect(result).toBeDefined()
  })

  it("returns undefined when not found", () => {
    expect(findHunkText("abc", "xyz")).toBeUndefined()
  })

  it("returns 0,0 for empty value", () => {
    expect(findHunkText("doc", "")).toEqual({ start: 0, end: 0 })
  })
})

describe("splitReviewDiff", () => {
  it("parses a single hunk", () => {
    const patch = "@@ -1,3 +1,4 @@\n line1\n+added\n line2\n line3"
    const result = splitReviewDiff(patch)
    expect(result.hunks).toHaveLength(1)
    expect(result.hunks[0]?.lines.length).toBeGreaterThan(0)
  })

  it("parses multiple hunks", () => {
    const patch = "@@ -1,3 +1,3 @@\n line1\n+a\n line2\n@@ -10,3 +10,4 @@\n lineA\n+b\n lineB"
    const result = splitReviewDiff(patch)
    expect(result.hunks).toHaveLength(2)
  })

  it("includes oldText / newText / anchorText / reversible per hunk", () => {
    const patch = "@@ -1,2 +1,3 @@\n ctx\n-old\n+new\n+extra"
    const hunk = splitReviewDiff(patch).hunks[0]
    expect(hunk).toBeDefined()
    expect(hunk!.oldText).toContain("old")
    expect(hunk!.newText).toContain("new")
    expect(hunk!.newText).toContain("extra")
  })
})

describe("diffLines / reviewLineText", () => {
  it("classifies lines by prefix", () => {
    const lines = diffLines("@@ -1 +1 @@\n+added\n-deleted\n context")
    const kinds = lines.map((l) => l.kind)
    expect(kinds).toContain("hunk")
    expect(kinds).toContain("add")
    expect(kinds).toContain("del")
    expect(kinds).toContain("ctx")
  })

  it("strips the leading +/-/space prefix in reviewLineText", () => {
    expect(reviewLineText({ kind: "add", text: "+hello" })).toBe("hello")
    expect(reviewLineText({ kind: "del", text: "-bye" })).toBe("bye")
    expect(reviewLineText({ kind: "ctx", text: " ok" })).toBe("ok")
  })
})

describe("firstReviewAnchor / firstChangedBlock", () => {
  it("returns the first added block", () => {
    const lines = diffLines("@@ -1 +1 @@\n ctx\n+a\n+b\n ctx2")
    expect(firstReviewAnchor(lines, "fallback")).toBe("a\nb")
  })

  it("falls back to first context block when no add lines", () => {
    const lines = diffLines("@@ -1 +1 @@\n context-line\n-removed")
    expect(firstReviewAnchor(lines, "fallback")).toBe("context-line")
  })

  it("returns empty for kind that's not present", () => {
    const lines = diffLines("@@ -1 +1 @@\n only-context\n more-context")
    expect(firstChangedBlock(lines, "add")).toBe("")
    expect(firstChangedBlock(lines, "del")).toBe("")
  })
})

describe("reviewKey", () => {
  it("composes a stable key from change source/path/hunk id", () => {
    const change = {
      source: "src1",
      path: "foo/bar.ts",
      kind: "updated" as const,
      additions: 1,
      deletions: 0,
      patch: "",
    }
    const key = reviewKey(change, "h0")
    expect(key).toContain("src1")
    expect(key).toContain("foo/bar.ts")
    expect(key).toContain("h0")
  })

  it("normalizes path in key (so backslashes don't produce a different key)", () => {
    const a = reviewKey({ source: "s", path: "foo/bar.ts", kind: "updated", additions: 0, deletions: 0, patch: "" }, "h")
    const b = reviewKey({ source: "s", path: "foo\\bar.ts", kind: "updated", additions: 0, deletions: 0, patch: "" }, "h")
    expect(a).toBe(b)
  })
})

describe("synthesizeCreatePatch", () => {
  it("synthesizes from write input.content", () => {
    const update = { callID: "c", tool: "write", status: "completed" as const, input: { content: "a\nb\nc" } }
    const result = synthesizeCreatePatch(update)
    expect(result).toContain("@@ -0,0 +1,3 @@")
    expect(result).toContain("+a")
    expect(result).toContain("+c")
  })

  it("synthesizes from edit input.newString", () => {
    const update = { callID: "c", tool: "edit", status: "completed" as const, input: { newString: "x\ny" } }
    expect(synthesizeCreatePatch(update)).toContain("@@ -0,0 +1,2 @@")
  })

  it("returns undefined for empty content", () => {
    expect(synthesizeCreatePatch({ callID: "c", tool: "write", status: "completed", input: { content: "" } })).toBeUndefined()
  })
})
