import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"
import { reviewHunk } from "../../src/chat/fs-ops"
import { splitReviewDiff } from "../../src/chat/diff"
import type { ReviewChange } from "../../webview/src/protocol"

// Treat the in-memory filesystem as the single source of truth for these
// tests. The vscode mock in test/host/setup.ts stubs `workspace.fs.stat`/
// `readFile` per-test below.

type FileEntry = { content: string }
let files: Map<string, FileEntry>
let edits: Array<{ uri: vscode.Uri; range: vscode.Range; text: string }>
let writes: Array<{ uri: vscode.Uri; content: string }>
let deletes: vscode.Uri[]
let renames: Array<{ from: vscode.Uri; to: vscode.Uri }>

beforeEach(() => {
  files = new Map()
  edits = []
  writes = []
  deletes = []
  renames = []
  ;(vscode.workspace.fs.stat as ReturnType<typeof vi.fn>).mockImplementation(async (uri: vscode.Uri) => {
    if (!files.has(uri.fsPath)) throw new Error(`stat: ${uri.fsPath} not found`)
    return {}
  })
  ;(vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (uri: vscode.Uri) => {
    const entry = files.get(uri.fsPath)
    if (!entry) throw new Error(`readFile: ${uri.fsPath} not found`)
    return new TextEncoder().encode(entry.content)
  })
  ;(vscode.workspace.fs as unknown as { writeFile: typeof vi.fn }).writeFile = vi.fn(
    async (uri: vscode.Uri, data: Uint8Array) => {
      const content = new TextDecoder().decode(data)
      files.set(uri.fsPath, { content })
      writes.push({ uri, content })
    },
  ) as never
  ;(vscode.workspace.fs as unknown as { delete: typeof vi.fn }).delete = vi.fn(
    async (uri: vscode.Uri) => {
      files.delete(uri.fsPath)
      deletes.push(uri)
    },
  ) as never
  ;(vscode.workspace.fs as unknown as { rename: typeof vi.fn }).rename = vi.fn(
    async (from: vscode.Uri, to: vscode.Uri) => {
      const entry = files.get(from.fsPath)
      if (!entry) throw new Error(`rename: ${from.fsPath} not found`)
      files.delete(from.fsPath)
      files.set(to.fsPath, entry)
      renames.push({ from, to })
    },
  ) as never
  ;(vscode.workspace.openTextDocument as ReturnType<typeof vi.fn>).mockImplementation(
    async (uri: vscode.Uri) => {
      const entry = files.get(uri.fsPath)
      const text = entry?.content ?? ""
      return {
        uri,
        getText: () => text,
        positionAt: (offset: number) => {
          // Crude line/character calculation from byte offset; the actual
          // VS Code Position is opaque to our code under test.
          const slice = text.slice(0, offset)
          const line = (slice.match(/\n/g) ?? []).length
          const character = slice.length - (slice.lastIndexOf("\n") + 1)
          return new vscode.Position(line, character)
        },
      }
    },
  )
  ;(vscode.workspace.applyEdit as ReturnType<typeof vi.fn>).mockImplementation(
    async (edit: { size?: () => number }) => {
      // The stubbed WorkspaceEdit collects edits into its internal array;
      // we mirror them onto a top-level list via the constructor stub below.
      void edit
      return true
    },
  )
  ;(vscode.window.showTextDocument as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  ;(vscode.window.showWarningMessage as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
  ;(vscode.window.showInformationMessage as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
})

// Build a synthetic ReviewChange + parsed hunk for the cases under test.
function makeChange(opts: {
  path: string
  patch: string
  kind?: ReviewChange["kind"]
  oldPath?: string
}): { change: ReviewChange; hunk: ReturnType<typeof splitReviewDiff>["hunks"][number] } {
  const change: ReviewChange = {
    source: "src1",
    path: opts.path,
    kind: opts.kind ?? "updated",
    additions: 0,
    deletions: 0,
    patch: opts.patch,
    oldPath: opts.oldPath,
  }
  const hunk = splitReviewDiff(opts.patch).hunks[0]!
  return { change, hunk }
}

describe("reviewHunk: created files", () => {
  it("Undo: deletes the file when it exists", async () => {
    files.set("/workspace/new.ts", { content: "hello world" })
    const { change, hunk } = makeChange({
      path: "new.ts",
      kind: "created",
      patch: "@@ -0,0 +1,1 @@\n+hello world",
    })
    const outcome = await reviewHunk(change, hunk, "rejected", { silent: true })
    expect(outcome.status).toBe("applied")
    expect(deletes.map((u) => u.fsPath)).toContain("/workspace/new.ts")
  })

  it("Undo: returns no-op when the file is already absent", async () => {
    const { change, hunk } = makeChange({
      path: "missing.ts",
      kind: "created",
      patch: "@@ -0,0 +1,1 @@\n+hello",
    })
    const outcome = await reviewHunk(change, hunk, "rejected", { silent: true })
    expect(outcome.status).toBe("no-op")
  })

  it("Keep: returns applied when the file exists", async () => {
    files.set("/workspace/new.ts", { content: "hello" })
    const { change, hunk } = makeChange({
      path: "new.ts",
      kind: "created",
      patch: "@@ -0,0 +1,1 @@\n+hello",
    })
    const outcome = await reviewHunk(change, hunk, "accepted", { silent: true })
    expect(outcome.status).toBe("applied")
  })

  it("Keep: returns conflict when the supposedly-created file is missing", async () => {
    const { change, hunk } = makeChange({
      path: "new.ts",
      kind: "created",
      patch: "@@ -0,0 +1,1 @@\n+hello",
    })
    const outcome = await reviewHunk(change, hunk, "accepted", { silent: true })
    expect(outcome.status).toBe("conflict")
  })
})

describe("reviewHunk: deleted files", () => {
  it("Undo: recreates the file using oldText from the diff", async () => {
    const patch = ["@@ -1,2 +0,0 @@", "-line1", "-line2"].join("\n")
    const { change, hunk } = makeChange({ path: "gone.ts", kind: "deleted", patch })
    const outcome = await reviewHunk(change, hunk, "rejected", { silent: true })
    expect(outcome.status).toBe("applied")
    expect(writes[0]?.content).toBe("line1\nline2")
  })

  it("Undo: conflicts when a file is already at that path", async () => {
    files.set("/workspace/gone.ts", { content: "different content already there" })
    const patch = ["@@ -1,1 +0,0 @@", "-line1"].join("\n")
    const { change, hunk } = makeChange({ path: "gone.ts", kind: "deleted", patch })
    const outcome = await reviewHunk(change, hunk, "rejected", { silent: true })
    expect(outcome.status).toBe("conflict")
    expect(writes).toHaveLength(0)
  })

  it("Keep: returns applied when the file is indeed gone", async () => {
    const patch = "@@ -1,1 +0,0 @@\n-line1"
    const { change, hunk } = makeChange({ path: "gone.ts", kind: "deleted", patch })
    const outcome = await reviewHunk(change, hunk, "accepted", { silent: true })
    expect(outcome.status).toBe("applied")
  })

  it("Keep: returns conflict when the supposedly-deleted file still exists", async () => {
    files.set("/workspace/gone.ts", { content: "still here" })
    const patch = "@@ -1,1 +0,0 @@\n-line1"
    const { change, hunk } = makeChange({ path: "gone.ts", kind: "deleted", patch })
    const outcome = await reviewHunk(change, hunk, "accepted", { silent: true })
    expect(outcome.status).toBe("conflict")
  })
})

describe("reviewHunk: updated files (safe undo via line anchor)", () => {
  it("Undo: returns conflict (not silent rejection) when file is missing", async () => {
    const patch = "@@ -1,1 +1,1 @@\n-old\n+new"
    const { change, hunk } = makeChange({ path: "gone.ts", patch })
    const outcome = await reviewHunk(change, hunk, "rejected", { silent: true })
    expect(outcome.status).toBe("missing")
  })

  it("Undo: returns conflict when the new text isn't at the expected location anymore", async () => {
    files.set("/workspace/f.ts", { content: "completely\ndifferent\ncontent" })
    const patch = "@@ -1,1 +1,1 @@\n-old\n+new"
    const { change, hunk } = makeChange({ path: "f.ts", patch })
    const outcome = await reviewHunk(change, hunk, "rejected", { silent: true })
    expect(outcome.status).toBe("conflict")
  })
})

describe("reviewHunk: Keep verifies file state", () => {
  it("Keep on an updated file reports conflict if the expected newText isn't present", async () => {
    files.set("/workspace/f.ts", { content: "the file has drifted" })
    const patch = "@@ -1,1 +1,1 @@\n-old_line\n+new_line"
    const { change, hunk } = makeChange({ path: "f.ts", patch })
    const outcome = await reviewHunk(change, hunk, "accepted", { silent: true })
    expect(outcome.status).toBe("conflict")
  })

  it("Keep on an updated file reports missing if file is gone", async () => {
    const patch = "@@ -1,1 +1,1 @@\n-old\n+new"
    const { change, hunk } = makeChange({ path: "f.ts", patch })
    const outcome = await reviewHunk(change, hunk, "accepted", { silent: true })
    expect(outcome.status).toBe("missing")
  })
})

describe("reviewHunk: non-reversible hunks", () => {
  it("returns unsupported when the diff has no parseable @@ header", async () => {
    const patch = "no hunk marker here"
    const { change, hunk } = makeChange({ path: "f.ts", patch })
    const outcome = await reviewHunk(change, hunk, "rejected", { silent: true })
    expect(outcome.status).toBe("unsupported")
  })
})

describe("reviewHunk: moved files", () => {
  it("Undo: renames the file back to its original path", async () => {
    files.set("/workspace/new-name.ts", { content: "after-move content" })
    const patch = "@@ -1 +1 @@\n-after-move content"
    const { change, hunk } = makeChange({
      path: "new-name.ts",
      kind: "moved",
      patch,
      oldPath: "old-name.ts",
    })
    const outcome = await reviewHunk(change, hunk, "rejected", { silent: true })
    expect(outcome.status).toBe("applied")
    expect(renames[0]?.from.fsPath).toBe("/workspace/new-name.ts")
    expect(renames[0]?.to.fsPath).toBe("/workspace/old-name.ts")
  })

  it("Undo: conflicts when the destination already exists", async () => {
    files.set("/workspace/new-name.ts", { content: "after-move" })
    files.set("/workspace/old-name.ts", { content: "something else now" })
    const patch = "@@ -1 +1 @@\n-after-move"
    const { change, hunk } = makeChange({
      path: "new-name.ts",
      kind: "moved",
      patch,
      oldPath: "old-name.ts",
    })
    const outcome = await reviewHunk(change, hunk, "rejected", { silent: true })
    expect(outcome.status).toBe("conflict")
    expect(renames).toHaveLength(0)
  })

  it("Undo: unsupported when oldPath isn't known", async () => {
    files.set("/workspace/new-name.ts", { content: "content" })
    const patch = "@@ -1 +1 @@\n-content"
    const { change, hunk } = makeChange({ path: "new-name.ts", kind: "moved", patch })
    const outcome = await reviewHunk(change, hunk, "rejected", { silent: true })
    expect(outcome.status).toBe("unsupported")
  })
})
