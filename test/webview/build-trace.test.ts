import { describe, it, expect } from "vitest"
import { buildTrace, mergeStatus, preferAction, pickPath } from "../../webview/src/components/ToolCard"
import { toolHeadline } from "../../webview/src/components/ToolCard"
import type { ToolUpdate } from "../../webview/src/protocol"

function update(partial: Partial<ToolUpdate> & { tool: string }): ToolUpdate {
  return {
    callID: partial.callID ?? `c-${Math.random()}`,
    tool: partial.tool,
    status: partial.status ?? "completed",
    title: partial.title,
    input: partial.input,
    metadata: partial.metadata,
    output: partial.output,
    error: partial.error,
  }
}

describe("buildTrace", () => {
  it("groups multiple reads of the same file under one entry", () => {
    const trace = buildTrace(
      [
        update({ tool: "read", input: { filePath: "foo.ts" } }),
        update({ tool: "read", input: { filePath: "foo.ts", offset: 100, limit: 50 } }),
      ],
      [],
    )
    expect(trace.reads).toHaveLength(1)
    expect(trace.reads[0]?.path).toBe("foo.ts")
  })

  it("upgrades a file from read → edit when both happen", () => {
    const trace = buildTrace(
      [
        update({ tool: "read", input: { filePath: "foo.ts" } }),
        update({
          tool: "edit",
          input: { filePath: "foo.ts" },
          metadata: { filediff: { additions: 5, deletions: 1 } },
        }),
      ],
      [],
    )
    expect(trace.reads).toHaveLength(0)
    expect(trace.edits).toHaveLength(1)
    expect(trace.edits[0]?.action).toBe("updated")
  })

  it("marks write with exists=false as created", () => {
    const trace = buildTrace(
      [
        update({
          tool: "write",
          input: { filePath: "new.ts", content: "line1\nline2" },
          metadata: { exists: false },
        }),
      ],
      [],
    )
    expect(trace.edits).toHaveLength(1)
    expect(trace.edits[0]?.action).toBe("created")
  })

  it("routes todowrite to trace.todos and out of others", () => {
    const trace = buildTrace(
      [
        update({ tool: "todowrite", input: { todos: [{ content: "do thing", status: "pending" }] } }),
      ],
      [],
    )
    expect(trace.todos).toBeDefined()
    expect(trace.todos).toHaveLength(1)
    expect(trace.others).toHaveLength(0)
  })

  it("classifies grep/glob as searches in others", () => {
    const trace = buildTrace(
      [
        update({ tool: "grep", input: { pattern: "TODO" } }),
        update({ tool: "glob", input: { pattern: "*.ts" } }),
      ],
      [],
    )
    expect(trace.others).toHaveLength(2)
    expect(trace.others[0]?.action).toBe("Grepped")
    expect(trace.others[1]?.action).toBe("Searched")
  })

  it("classifies bash as Ran", () => {
    const trace = buildTrace(
      [update({ tool: "bash", input: { command: "ls" } })],
      [],
    )
    expect(trace.others).toHaveLength(1)
    expect(trace.others[0]?.action).toBe("Ran")
  })

  it("ingests patch blocks alongside tool calls and dedupes by path", () => {
    const trace = buildTrace(
      [
        update({
          tool: "edit",
          input: { filePath: "foo.ts" },
          metadata: { filediff: { additions: 5, deletions: 1 } },
        }),
      ],
      [{ files: ["A foo.ts"] }],
    )
    expect(trace.edits).toHaveLength(1)
    expect(trace.edits[0]?.path).toBe("foo.ts")
  })

  it("processes apply_patch metadata.files entries", () => {
    const trace = buildTrace(
      [
        update({
          tool: "apply_patch",
          metadata: {
            files: [
              { relativePath: "a.ts", type: "modify", additions: 5, deletions: 1 },
              { relativePath: "b.ts", type: "add", additions: 10, deletions: 0 },
            ],
          },
        }),
      ],
      [],
    )
    expect(trace.edits).toHaveLength(2)
    expect(trace.edits.find((e) => e.path === "b.ts")?.action).toBe("created")
  })
})

describe("toolHeadline", () => {
  it("describes a single edit by file basename", () => {
    const h = toolHeadline([
      update({
        tool: "edit",
        input: { filePath: "src/foo.ts" },
        metadata: { filediff: { additions: 1 } },
      }),
    ])
    expect(h).toContain("foo.ts")
  })

  it("aggregates multiple edits into 'Changed N files'", () => {
    const h = toolHeadline([
      update({ tool: "edit", input: { filePath: "a.ts" }, metadata: { filediff: { additions: 1 } } }),
      update({ tool: "edit", input: { filePath: "b.ts" }, metadata: { filediff: { additions: 1 } } }),
      update({ tool: "edit", input: { filePath: "c.ts" }, metadata: { filediff: { additions: 1 } } }),
    ])
    expect(h).toContain("3")
  })

  it("falls back to read count when no edits", () => {
    const h = toolHeadline([
      update({ tool: "read", input: { filePath: "a.ts" } }),
      update({ tool: "read", input: { filePath: "b.ts" } }),
    ])
    expect(h).toContain("Read")
    expect(h).toContain("2")
  })
})

describe("mergeStatus / preferAction", () => {
  it("error overrides everything", () => {
    expect(mergeStatus("completed", "error")).toBe("error")
    expect(mergeStatus("error", "completed")).toBe("error")
  })

  it("running beats pending and completed when neither is error", () => {
    expect(mergeStatus("pending", "running")).toBe("running")
    expect(mergeStatus("running", "completed")).toBe("running")
  })

  it("read is overridden by an edit/create action", () => {
    expect(preferAction("read", "updated")).toBe("updated")
    expect(preferAction("read", "created")).toBe("created")
  })

  it("created beats updated", () => {
    expect(preferAction("updated", "created")).toBe("created")
    expect(preferAction("created", "updated")).toBe("created")
  })
})

describe("pickPath", () => {
  it("picks input.filePath", () => {
    expect(pickPath(update({ tool: "read", input: { filePath: "x.ts" } }))).toBe("x.ts")
  })

  it("picks input.path for file tools", () => {
    expect(pickPath(update({ tool: "read", input: { path: "y.ts" } }))).toBe("y.ts")
  })

  it("picks update.title for file tools as a last resort", () => {
    expect(pickPath(update({ tool: "edit", title: "z.ts" }))).toBe("z.ts")
  })

  it("returns undefined for non-file tools without explicit filePath", () => {
    expect(pickPath(update({ tool: "grep", input: { pattern: "x" } }))).toBeUndefined()
  })
})
