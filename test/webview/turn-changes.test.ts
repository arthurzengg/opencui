import { describe, it, expect } from "vitest"
import { turnChanges, toolChanges, synthesizeCreatePatch, splitDiff, isTextReviewChange } from "../../webview/src/components/ReviewPanel"
import { aggregateChanges, type ReviewChange } from "../../webview/src/review-extract"
import type { Message } from "../../webview/src/hooks/useChatState"

describe("synthesizeCreatePatch", () => {
  it("produces a patch from write tool input.content", () => {
    const update = { tool: "write", input: { content: "line1\nline2\nline3" } }
    const result = synthesizeCreatePatch(update)
    expect(result).toContain("@@ -0,0 +1,3 @@")
    expect(result).toContain("+line1")
    expect(result).toContain("+line2")
    expect(result).toContain("+line3")
  })

  it("strips trailing empty line from content ending in \\n", () => {
    const update = { tool: "write", input: { content: "line1\nline2\n" } }
    const result = synthesizeCreatePatch(update)
    expect(result).toContain("@@ -0,0 +1,2 @@")
  })

  it("produces a patch from edit tool input.newString", () => {
    const update = { tool: "edit", input: { newString: "new\ncontent" } }
    expect(synthesizeCreatePatch(update)).toContain("@@ -0,0 +1,2 @@")
  })

  it("returns undefined for empty content", () => {
    expect(synthesizeCreatePatch({ tool: "write", input: { content: "" } })).toBeUndefined()
    expect(synthesizeCreatePatch({ tool: "write", input: {} })).toBeUndefined()
  })

  it("returns undefined for unrelated tools", () => {
    expect(synthesizeCreatePatch({ tool: "read", input: { content: "x" } })).toBeUndefined()
  })
})

describe("isTextReviewChange", () => {
  const baseChange = {
    source: "s1",
    path: "foo.ts",
    kind: "updated" as const,
    additions: 5,
    deletions: 2,
    patch: "@@ -1 +1 @@\n-old\n+new",
  }

  it("accepts a normal text-file change", () => {
    expect(isTextReviewChange(baseChange)).toBe(true)
  })

  it("rejects when both additions and deletions are 0", () => {
    expect(isTextReviewChange({ ...baseChange, additions: 0, deletions: 0 })).toBe(false)
  })
})

describe("splitDiff", () => {
  it("returns one hunk per @@ marker", () => {
    const patch = "@@ -1,3 +1,4 @@\n line\n+add\n line\n@@ -10,2 +11,3 @@\n line\n+add"
    const result = splitDiff(patch)
    expect(result.hunks).toHaveLength(2)
  })

  it("returns one hunk for single-hunk patches", () => {
    const patch = "@@ -1,3 +1,4 @@\n line\n+add"
    expect(splitDiff(patch).hunks).toHaveLength(1)
  })

  it("returns one hunk for non-@@ content (synthesized create patch)", () => {
    const patch = "@@ -0,0 +1,3 @@\n+line1\n+line2\n+line3"
    expect(splitDiff(patch).hunks).toHaveLength(1)
  })

  it("falls back to a single 0-file hunk for content without @@ markers", () => {
    expect(splitDiff("nodiff content").hunks).toHaveLength(1)
  })

  it("returns empty for empty patches", () => {
    expect(splitDiff("").hunks).toHaveLength(0)
  })
})

describe("turnChanges", () => {
  function toolMessage(id: string, blockIndex: number, change: { tool: string; metadata?: Record<string, unknown>; input?: Record<string, unknown>; status?: string }): Message {
    return {
      id,
      role: "assistant",
      blocks: Array.from({ length: blockIndex }, () => ({ type: "text" as const, text: "" })).concat([
        { type: "tool" as const, update: { callID: `call-${id}-${blockIndex}`, tool: change.tool, status: (change.status ?? "completed") as "completed", input: change.input, metadata: change.metadata } },
      ]),
    }
  }

  it("aggregates additions/deletions when same path is modified multiple times", () => {
    const messages: Message[] = [
      toolMessage("m1", 0, {
        tool: "edit",
        metadata: { filediff: { patch: "@@\n+a\n+a\n+a\n+a\n+a\n+a\n+a\n+a\n+a\n+a", additions: 10, deletions: 0 } },
        input: { filePath: "foo.ts" },
      }),
      toolMessage("m2", 0, {
        tool: "edit",
        metadata: { filediff: { patch: "@@\n+a\n+a\n+a\n+a\n+a\n-x\n-x", additions: 5, deletions: 2 } },
        input: { filePath: "foo.ts" },
      }),
    ]
    const result = turnChanges(messages)
    expect(result).toHaveLength(1)
    expect(result[0].additions).toBe(15)
    expect(result[0].deletions).toBe(2)
  })

  it("retains 'created' kind when first change was create then later updated", () => {
    const messages: Message[] = [
      toolMessage("m1", 0, {
        tool: "write",
        metadata: { exists: false, filediff: { patch: "@@\n+a", additions: 1, deletions: 0 } },
        input: { filePath: "new.ts", content: "a" },
      }),
      toolMessage("m2", 0, {
        tool: "edit",
        metadata: { filediff: { patch: "@@\n+b", additions: 1, deletions: 0 } },
        input: { filePath: "new.ts" },
      }),
    ]
    const result = turnChanges(messages)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe("created")
    expect(result[0].additions).toBe(2)
  })

  it("returns empty for messages with no review-relevant blocks", () => {
    const messages: Message[] = [
      { id: "u1", role: "user", blocks: [{ type: "text", text: "hello" }] },
      { id: "a1", role: "assistant", blocks: [{ type: "text", text: "hi" }] },
    ]
    expect(turnChanges(messages)).toHaveLength(0)
  })
})

describe("aggregateChanges", () => {
  function change(over: Partial<ReviewChange>): ReviewChange {
    return {
      source: "s",
      path: "a.ts",
      kind: "updated",
      additions: 1,
      deletions: 0,
      patch: "@@\n+x",
      ...over,
    }
  }

  it("keeps rows in first-appearance order, merging onto the original row", () => {
    const result = aggregateChanges([
      change({ path: "a.ts", source: "s1" }),
      change({ path: "b.ts", source: "s2" }),
      change({ path: "a.ts", source: "s3" }),
      change({ path: "c.ts", source: "s4" }),
    ])
    expect(result.map((c) => c.path)).toEqual(["a.ts", "b.ts", "c.ts"])
  })

  it("merges records whose paths differ only by normalization", () => {
    const result = aggregateChanges([
      change({ path: "./src/foo.ts", additions: 2 }),
      change({ path: "src\\foo.ts", additions: 3 }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.additions).toBe(5)
  })

  it("takes source and patch from the most recent record and sums counts", () => {
    const result = aggregateChanges([
      change({ source: "first", patch: "@@\n+a", additions: 1, deletions: 1 }),
      change({ source: "last", patch: "@@\n+b", additions: 2, deletions: 3 }),
    ])
    expect(result[0]).toMatchObject({ source: "last", patch: "@@\n+b", additions: 3, deletions: 4 })
  })

  it("prefers the later sticky kind when two sticky kinds conflict", () => {
    const result = aggregateChanges([change({ kind: "created" }), change({ kind: "deleted" })])
    expect(result[0]!.kind).toBe("deleted")
  })

  it("keeps the first oldPath and the latest absolutePath", () => {
    const result = aggregateChanges([
      change({ kind: "moved", oldPath: "old.ts", absolutePath: "/w/1.ts" }),
      change({ absolutePath: "/w/2.ts" }),
    ])
    expect(result[0]!.oldPath).toBe("old.ts")
    expect(result[0]!.absolutePath).toBe("/w/2.ts")
  })

  it("dedupes actors across merged records", () => {
    const main = { kind: "main" as const }
    const sub = { kind: "subagent" as const, sessionID: "child_1", subagent: "explore" }
    const result = aggregateChanges([
      change({ actors: [main] }),
      change({ actors: [sub, main] }),
    ])
    expect(result[0]!.actors).toEqual([main, sub])
  })

  it("drops the actors field entirely when no record carries one", () => {
    const result = aggregateChanges([change({}), change({})])
    expect(result[0]!.actors).toBeUndefined()
  })
})

describe("toolChanges (write/edit create flow)", () => {
  it("returns empty array for write without content (no filediff)", () => {
    const result = toolChanges(
      { tool: "write", input: { filePath: "f.ts" }, metadata: { exists: false } },
      "src1",
    )
    expect(result).toHaveLength(0)
  })
})
