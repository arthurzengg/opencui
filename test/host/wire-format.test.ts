import { describe, it, expect } from "vitest"
import { toWire } from "../../src/chat/wire-format"
import type { ToolUpdate } from "../../src/chat/stream"

const CWD = "/ws"

function update(overrides: Partial<ToolUpdate> = {}): ToolUpdate {
  return { callID: "call_1", tool: "read", status: "completed", ...overrides }
}

describe("toWire", () => {
  it("passes scalar fields through and keeps absent input/metadata undefined", () => {
    const wire = toWire(
      update({ title: "Read a file", output: "contents", error: "boom" }),
      CWD,
    )
    expect(wire).toEqual({
      callID: "call_1",
      tool: "read",
      status: "completed",
      title: "Read a file",
      input: undefined,
      metadata: undefined,
      output: "contents",
      error: "boom",
    })
  })

  it("rewrites an absolute input.filePath relative to the workspace", () => {
    const wire = toWire(update({ input: { filePath: "/ws/src/a.ts" } }), CWD)
    expect(wire.input?.filePath).toBe("src/a.ts")
  })

  it("leaves an absolute filePath outside the workspace untouched", () => {
    const wire = toWire(update({ input: { filePath: "/elsewhere/a.ts" } }), CWD)
    expect(wire.input?.filePath).toBe("/elsewhere/a.ts")
  })

  it("strips a leading worktree-basename prefix from a relative filePath", () => {
    const wire = toWire(update({ input: { filePath: "ws/src/a.ts" } }), CWD)
    expect(wire.input?.filePath).toBe("src/a.ts")
  })

  it("prefers the absolute path opencode resolved in metadata over the raw input", () => {
    const wire = toWire(
      update({
        input: { filePath: "worktree/src/wrong.ts" },
        metadata: { filepath: "/ws/src/real.ts" },
      }),
      CWD,
    )
    expect(wire.input?.filePath).toBe("src/real.ts")
    // metadata.filepath is only rewritten when relative; the resolved absolute
    // path stays absolute there.
    expect(wire.metadata?.filepath).toBe("/ws/src/real.ts")
  })

  it("falls back to filediff.file as the resolved path", () => {
    const wire = toWire(
      update({
        input: { filePath: "wrong.ts" },
        metadata: { filediff: { file: "/ws/src/diffed.ts" } },
      }),
      CWD,
    )
    expect(wire.input?.filePath).toBe("src/diffed.ts")
  })

  it("ignores a relative resolved path and rewrites the raw input instead", () => {
    const wire = toWire(
      update({
        input: { filePath: "/ws/src/raw.ts" },
        metadata: { filepath: "ws/src/resolved.ts" },
      }),
      CWD,
    )
    // The metadata path normalizes first (worktree prefix stripped), so it is
    // no longer absolute and cannot override the input rewrite.
    expect(wire.metadata?.filepath).toBe("src/resolved.ts")
    expect(wire.input?.filePath).toBe("src/raw.ts")
  })

  it("rewrites input.path the same way", () => {
    const wire = toWire(update({ input: { path: "/ws/src/dir" } }), CWD)
    expect(wire.input?.path).toBe("src/dir")
  })

  it("rewrites a relative filediff.file and keeps an absolute one", () => {
    const relative = toWire(update({ metadata: { filediff: { file: "ws/g.ts" } } }), CWD)
    expect(relative.metadata?.filediff).toEqual({ file: "g.ts" })
    const absolute = toWire(update({ metadata: { filediff: { file: "/ws/g.ts" } } }), CWD)
    expect(absolute.metadata?.filediff).toEqual({ file: "/ws/g.ts" })
  })

  it("rewrites files[].relativePath and passes non-record entries through", () => {
    const wire = toWire(
      update({
        metadata: {
          files: [{ relativePath: "ws/src/f.ts", type: "add" }, "junk", { noPath: true }],
        },
      }),
      CWD,
    )
    expect(wire.metadata?.files).toEqual([
      { relativePath: "src/f.ts", type: "add" },
      "junk",
      { noPath: true },
    ])
  })

  it("does not mutate the original update", () => {
    const original = update({
      input: { filePath: "/ws/src/a.ts" },
      metadata: { filepath: "ws/b.ts", filediff: { file: "ws/c.ts" }, files: [{ relativePath: "ws/d.ts" }] },
    })
    toWire(original, CWD)
    expect(original.input).toEqual({ filePath: "/ws/src/a.ts" })
    expect(original.metadata).toEqual({
      filepath: "ws/b.ts",
      filediff: { file: "ws/c.ts" },
      files: [{ relativePath: "ws/d.ts" }],
    })
  })
})
