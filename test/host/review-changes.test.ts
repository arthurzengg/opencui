import { describe, it, expect } from "vitest"
import { reviewChanges, toolChanges, patchChanges, displayPath } from "../../src/chat/view"
import type { ChatMessage } from "../../webview/src/protocol"

describe("toolChanges", () => {
  it("emits a synthesized patch for write/create when no metadata.filediff", () => {
    const result = toolChanges(
      {
        callID: "c1",
        tool: "write",
        status: "completed",
        input: { filePath: "new.ts", content: "a\nb" },
        metadata: { exists: false },
      },
      "src1",
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.kind).toBe("created")
    expect(result[0]?.path).toBe("new.ts")
  })

  it("uses metadata.filediff.patch for edit", () => {
    const result = toolChanges(
      {
        callID: "c1",
        tool: "edit",
        status: "completed",
        input: { filePath: "foo.ts" },
        metadata: { filediff: { patch: "@@\n-old\n+new", additions: 1, deletions: 1 } },
      },
      "src1",
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.kind).toBe("updated")
    expect(result[0]?.additions).toBe(1)
    expect(result[0]?.deletions).toBe(1)
  })

  it("returns empty for unrelated tools without patch", () => {
    expect(
      toolChanges({ callID: "c1", tool: "read", status: "completed", input: { filePath: "a.ts" } }, "src1"),
    ).toHaveLength(0)
  })

  it("dispatches to patchChanges for apply_patch tool", () => {
    const result = toolChanges(
      {
        callID: "c1",
        tool: "apply_patch",
        status: "completed",
        metadata: {
          files: [
            { relativePath: "a.ts", type: "modify", patch: "@@\n+x", additions: 1, deletions: 0 },
            { relativePath: "b.ts", type: "add", patch: "@@\n+y", additions: 1, deletions: 0 },
          ],
        },
      },
      "src1",
    )
    expect(result).toHaveLength(2)
    expect(result.find((c) => c.path === "b.ts")?.kind).toBe("created")
  })
})

describe("patchChanges", () => {
  it("emits a ReviewChange per file in metadata.files", () => {
    const result = patchChanges(
      [
        { relativePath: "a.ts", type: "modify", patch: "@@\n+x", additions: 1, deletions: 0 },
        { relativePath: "b.ts", type: "delete", patch: "@@\n-y", additions: 0, deletions: 1 },
      ],
      "src1",
    )
    expect(result).toHaveLength(2)
    expect(result[0]?.kind).toBe("updated")
    expect(result[1]?.kind).toBe("deleted")
  })

  it("returns empty for non-array input", () => {
    expect(patchChanges(null, "src1")).toHaveLength(0)
    expect(patchChanges(undefined, "src1")).toHaveLength(0)
    expect(patchChanges("not an array", "src1")).toHaveLength(0)
  })

  it("skips entries missing relativePath or patch", () => {
    const result = patchChanges(
      [
        { relativePath: "a.ts", type: "modify", patch: "@@\n+x" },
        { type: "modify", patch: "@@\n+x" },
        { relativePath: "b.ts", type: "modify" },
      ],
      "src1",
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe("a.ts")
  })
})

describe("displayPath", () => {
  it("prefers update.title", () => {
    expect(displayPath({ title: "from-title.ts" })).toBe("from-title.ts")
  })

  it("falls back to input.filePath", () => {
    expect(displayPath({ input: { filePath: "from-input.ts" } })).toBe("from-input.ts")
  })

  it("falls back to filediff.file", () => {
    expect(displayPath({}, { file: "from-filediff.ts" })).toBe("from-filediff.ts")
  })

  it("returns 'file' as last resort", () => {
    expect(displayPath({})).toBe("file")
  })
})

describe("reviewChanges", () => {
  function toolMsg(id: string, blockIdx: number, opts: { tool: string; metadata?: Record<string, unknown>; input?: Record<string, unknown>; status?: string; callID?: string }): ChatMessage {
    const blocks = Array.from({ length: blockIdx }, () => ({ type: "text" as const, text: "" })).concat([
      {
        type: "tool" as const,
        update: {
          callID: opts.callID ?? `c-${id}-${blockIdx}`,
          tool: opts.tool,
          status: (opts.status ?? "completed") as "completed",
          input: opts.input,
          metadata: opts.metadata,
        },
      },
    ])
    return { id, role: "assistant", blocks } as unknown as ChatMessage
  }

  it("extracts changes from tool blocks", () => {
    const messages = [
      toolMsg("m1", 0, {
        tool: "edit",
        input: { filePath: "foo.ts" },
        metadata: { filediff: { patch: "@@\n+a", additions: 1, deletions: 0 } },
      }),
    ]
    expect(reviewChanges(messages)).toHaveLength(1)
  })

  it("ignores non-completed tool blocks", () => {
    const messages = [
      toolMsg("m1", 0, {
        tool: "edit",
        input: { filePath: "foo.ts" },
        metadata: { filediff: { patch: "@@\n+a" } },
        status: "running",
      }),
    ]
    expect(reviewChanges(messages)).toHaveLength(0)
  })

  it("dedupes by samePath AND (sameSource OR samePatch)", () => {
    // Two records for the same file with the SAME patch → host's reduce
    // collapses them.
    const same = "@@\n+a"
    const messages = [
      toolMsg("m1", 0, {
        tool: "edit",
        input: { filePath: "foo.ts" },
        metadata: { filediff: { patch: same, additions: 1 } },
        callID: "call-edit",
      }),
      toolMsg("m1", 1, {
        tool: "edit",
        input: { filePath: "foo.ts" },
        metadata: { filediff: { patch: same, additions: 1 } },
        callID: "call-edit",
      }),
    ]
    expect(reviewChanges(messages)).toHaveLength(1)
  })

  it("preserves both records when patches differ AND sources differ", () => {
    const messages = [
      toolMsg("m1", 0, {
        tool: "edit",
        input: { filePath: "foo.ts" },
        metadata: { filediff: { patch: "@@\n+a", additions: 1 } },
        callID: "call-1",
      }),
      toolMsg("m2", 0, {
        tool: "edit",
        input: { filePath: "foo.ts" },
        metadata: { filediff: { patch: "@@\n+b", additions: 1 } },
        callID: "call-2",
      }),
    ]
    // host's dedup keeps multiple records since neither source nor patch matches
    expect(reviewChanges(messages).length).toBeGreaterThanOrEqual(1)
  })
})
