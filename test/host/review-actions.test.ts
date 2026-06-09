import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"
import { reviewHunk, findExistingWorkspaceFile, type ReviewHunkOutcome } from "../../src/chat/fs-ops"
import { splitReviewDiff } from "../../src/chat/diff"
import { reviewKey } from "../../webview/src/review-extract"
import { reviewAllForPath } from "../../src/chat/review-actions"
import type { ReviewChange, ReviewHunkState } from "../../webview/src/protocol"

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

describe("reviewHunk: undo of context-free deletion hunks", () => {
  beforeEach(() => {
    ;(vscode.workspace.applyEdit as ReturnType<typeof vi.fn>).mockImplementation(
      async (edit: unknown) => {
        const ops = (edit as { edits?: Array<{ uri: vscode.Uri; range: vscode.Range; text: string }> }).edits
        if (!ops) return true
        for (const op of [...ops].reverse()) {
          const entry = files.get(op.uri.fsPath)
          if (!entry) continue
          const start = offsetFromPosition(entry.content, op.range.start)
          const end = offsetFromPosition(entry.content, op.range.end)
          entry.content = entry.content.slice(0, start) + op.text + entry.content.slice(end)
        }
        return true
      },
    )
  })

  it("restores deleted lines at their original position with the separator newline", async () => {
    // Original: line1..line5. opencode deleted line3+line4 (no context lines).
    files.set("/workspace/a.ts", { content: "line1\nline2\nline5\n" })
    const patch = "@@ -3,2 +2,0 @@\n-line3\n-line4"
    const { change, hunk } = makeChange({ path: "a.ts", patch })
    const outcome = await reviewHunk(change, hunk, "rejected", { silent: true })
    expect(outcome.status).toBe("applied")
    // Regression: the old anchor put the block one line early and glued it
    // to the following line ("line1\nline3\nline4line2\n…").
    expect(files.get("/workspace/a.ts")?.content).toBe("line1\nline2\nline3\nline4\nline5\n")
  })

  it("restores a deleted trailing block at EOF of a newline-terminated file", async () => {
    files.set("/workspace/b.ts", { content: "line1\nline2\n" })
    const patch = "@@ -3,1 +2,0 @@\n-line3"
    const { change, hunk } = makeChange({ path: "b.ts", patch })
    const outcome = await reviewHunk(change, hunk, "rejected", { silent: true })
    expect(outcome.status).toBe("applied")
    expect(files.get("/workspace/b.ts")?.content).toBe("line1\nline2\nline3")
  })
})

describe("reviewHunk: moved files with edits", () => {
  // Mirror WorkspaceEdit.replace onto the in-memory file map so the content
  // revert is observable (the shared applyEdit mock just returns true).
  beforeEach(() => {
    ;(vscode.workspace.applyEdit as ReturnType<typeof vi.fn>).mockImplementation(
      async (edit: unknown) => {
        const ops = (edit as { edits?: Array<{ uri: vscode.Uri; range: vscode.Range; text: string }> }).edits
        if (!ops) return true
        for (const op of [...ops].reverse()) {
          const entry = files.get(op.uri.fsPath)
          if (!entry) continue
          const start = offsetFromPosition(entry.content, op.range.start)
          const end = offsetFromPosition(entry.content, op.range.end)
          entry.content = entry.content.slice(0, start) + op.text + entry.content.slice(end)
        }
        return true
      },
    )
  })

  it("Undo: reverts only the hunk's lines and keeps the rest of the file intact", async () => {
    files.set("/workspace/new-name.ts", { content: "line1\nEDITED\nline3\nline4\n" })
    const patch = "@@ -2,1 +2,1 @@\n-ORIGINAL\n+EDITED"
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
    // The regression: the old code wrote hunk.oldText as the WHOLE file,
    // destroying line1/line3/line4.
    expect(files.get("/workspace/old-name.ts")?.content).toBe("line1\nORIGINAL\nline3\nline4\n")
  })

  it("Undo: a later hunk applies its content revert after an earlier hunk already renamed the file back", async () => {
    files.set("/workspace/old-name.ts", { content: "line1\nEDITED\nline3\n" })
    const patch = "@@ -2,1 +2,1 @@\n-ORIGINAL\n+EDITED"
    const { change, hunk } = makeChange({
      path: "new-name.ts",
      kind: "moved",
      patch,
      oldPath: "old-name.ts",
    })
    const outcome = await reviewHunk(change, hunk, "rejected", { silent: true })
    expect(outcome.status).toBe("applied")
    expect(renames).toHaveLength(0)
    expect(files.get("/workspace/old-name.ts")?.content).toBe("line1\nORIGINAL\nline3\n")
  })
})

describe("reviewAllForPath: multi-tool turn", () => {
  // `applyEdit` in the shared mock just returns `true`; for these tests we need
  // it to actually mutate the on-disk file map so chained undos see the
  // previous one's effect. We patch it per-block to mirror each
  // WorkspaceEdit's `.replace(uri, range, text)` calls onto `files`.
  beforeEach(() => {
    ;(vscode.workspace.applyEdit as ReturnType<typeof vi.fn>).mockImplementation(
      async (edit: unknown) => {
        const ops = (edit as { edits?: Array<{ uri: vscode.Uri; range: vscode.Range; text: string }> }).edits
        if (!ops) return true
        for (const op of [...ops].reverse()) {
          const entry = files.get(op.uri.fsPath)
          if (!entry) continue
          const start = offsetFromPosition(entry.content, op.range.start)
          const end = offsetFromPosition(entry.content, op.range.end)
          entry.content = entry.content.slice(0, start) + op.text + entry.content.slice(end)
        }
        return true
      },
    )
  })

  function buildUpdate(opts: {
    source: string
    path: string
    oldText: string
    newText: string
    line: number
  }): ReviewChange {
    const patch = [
      `@@ -${opts.line},1 +${opts.line},1 @@`,
      `-${opts.oldText}`,
      `+${opts.newText}`,
    ].join("\n")
    return {
      source: opts.source,
      path: opts.path,
      kind: "updated",
      additions: 1,
      deletions: 1,
      patch,
    }
  }

  function aggregateLike(records: ReviewChange[]): ReviewChange {
    // Mirror the production `aggregateChanges` rule: source/patch from the
    // LAST contributing record, additions/deletions summed, kind taken via
    // priorityKind. These tests use only `updated` records unless a test
    // explicitly overrides `kind`, so plain `updated` is the default.
    const last = records[records.length - 1]!
    return {
      ...last,
      additions: records.reduce((sum, r) => sum + r.additions, 0),
      deletions: records.reduce((sum, r) => sum + r.deletions, 0),
    }
  }

  it("layered edits on the same line: reverse-order undo restores the original", async () => {
    files.set("/workspace/foo.ts", { content: "alpha\nfinal\ngamma\n" })
    const recordA = buildUpdate({ source: "callA", path: "foo.ts", oldText: "beta", newText: "rev1", line: 2 })
    const recordB = buildUpdate({ source: "callB", path: "foo.ts", oldText: "rev1", newText: "final", line: 2 })
    const aggregated = aggregateLike([recordA, recordB])
    const result = await reviewAllForPath([recordA, recordB], aggregated, "rejected", { reviewedKeys: {} })
    expect(result.applied).toBe(2)
    expect(result.conflicts).toBe(0)
    expect(files.get("/workspace/foo.ts")?.content).toBe("alpha\nbeta\ngamma\n")
    expect(result.hunkUpdates.length).toBeGreaterThan(0)
    for (const update of result.hunkUpdates) {
      expect(update.state).toBe("rejected")
    }
  })

  it("non-overlapping edits in same file: reverse-order undo restores both lines", async () => {
    files.set("/workspace/foo.ts", { content: "one\ntwo-revA\nthree\nfour\nfive-revB\n" })
    const recordA = buildUpdate({ source: "callA", path: "foo.ts", oldText: "two", newText: "two-revA", line: 2 })
    const recordB = buildUpdate({ source: "callB", path: "foo.ts", oldText: "five", newText: "five-revB", line: 5 })
    const aggregated = aggregateLike([recordA, recordB])
    const result = await reviewAllForPath([recordA, recordB], aggregated, "rejected", { reviewedKeys: {} })
    expect(result.applied).toBe(2)
    expect(result.conflicts).toBe(0)
    expect(files.get("/workspace/foo.ts")?.content).toBe("one\ntwo\nthree\nfour\nfive\n")
  })

  it("undo iterates per-tool records in REVERSE order; keep iterates forward", async () => {
    const seen: Array<{ source: string; action: ReviewHunkState }> = []
    const runner = vi.fn(async (change: ReviewChange, _hunk, action) => {
      seen.push({ source: change.source, action })
      return { status: "applied" } satisfies ReviewHunkOutcome
    })
    const recordA = buildUpdate({ source: "callA", path: "foo.ts", oldText: "X", newText: "Y", line: 1 })
    const recordB = buildUpdate({ source: "callB", path: "foo.ts", oldText: "Y", newText: "Z", line: 1 })
    const aggregated = aggregateLike([recordA, recordB])

    await reviewAllForPath([recordA, recordB], aggregated, "rejected", { reviewedKeys: {}, runReviewHunk: runner })
    expect(seen.map((s) => s.source)).toEqual(["callB", "callA"])

    seen.length = 0
    await reviewAllForPath([recordA, recordB], aggregated, "accepted", { reviewedKeys: {}, runReviewHunk: runner })
    expect(seen.map((s) => s.source)).toEqual(["callA", "callB"])
  })

  it("is idempotent: a re-click with all aggregated hunks already marked is a no-op", async () => {
    const runner = vi.fn(async () => ({ status: "applied" }) satisfies ReviewHunkOutcome)
    const record = buildUpdate({ source: "callA", path: "foo.ts", oldText: "X", newText: "Y", line: 1 })
    const aggregated = aggregateLike([record])
    const reviewedKeys: Record<string, ReviewHunkState> = {}
    for (const hunk of splitReviewDiff(aggregated.patch).hunks) {
      reviewedKeys[reviewKey(aggregated, hunk.id)] = "rejected"
    }
    const result = await reviewAllForPath([record], aggregated, "rejected", { reviewedKeys, runReviewHunk: runner })
    expect(result.applied).toBe(0)
    expect(result.conflicts).toBe(0)
    expect(result.hunkUpdates).toHaveLength(0)
    expect(runner).not.toHaveBeenCalled()
  })

  it("mixed conflict: one record applies, one drift-conflicts; aggregated hunks still marked because applied > 0", async () => {
    // line 1 has drifted out from under us, line 5 still matches recordB.
    files.set("/workspace/foo.ts", { content: "drifted\ntwo\nthree\nfour\nfive-revB\n" })
    const recordA = buildUpdate({ source: "callA", path: "foo.ts", oldText: "one", newText: "one-revA", line: 1 })
    const recordB = buildUpdate({ source: "callB", path: "foo.ts", oldText: "five", newText: "five-revB", line: 5 })
    const aggregated = aggregateLike([recordA, recordB])
    const result = await reviewAllForPath([recordA, recordB], aggregated, "rejected", { reviewedKeys: {} })
    expect(result.applied).toBe(1)
    expect(result.conflicts).toBe(1)
    expect(result.hunkUpdates.length).toBeGreaterThan(0)
    expect(files.get("/workspace/foo.ts")?.content).toBe("drifted\ntwo\nthree\nfour\nfive\n")
  })

  it("mixed kind (create + update): reverse undo reverts the edit then deletes the file", async () => {
    files.set("/workspace/new.ts", { content: "hello-edited\n" })
    const createRecord: ReviewChange = {
      source: "callA",
      path: "new.ts",
      kind: "created",
      additions: 1,
      deletions: 0,
      patch: "@@ -0,0 +1,1 @@\n+hello",
    }
    const editRecord = buildUpdate({ source: "callB", path: "new.ts", oldText: "hello", newText: "hello-edited", line: 1 })
    const aggregated: ReviewChange = { ...editRecord, kind: "created" }
    const result = await reviewAllForPath([createRecord, editRecord], aggregated, "rejected", { reviewedKeys: {} })
    expect(result.applied).toBe(2)
    expect(result.conflicts).toBe(0)
    expect(deletes.map((u) => u.fsPath)).toContain("/workspace/new.ts")
    expect(files.has("/workspace/new.ts")).toBe(false)
  })

  it("returns zeros when no records match (defensive)", async () => {
    const aggregated = buildUpdate({ source: "callA", path: "foo.ts", oldText: "X", newText: "Y", line: 1 })
    const result = await reviewAllForPath([], aggregated, "rejected", { reviewedKeys: {} })
    expect(result.applied).toBe(0)
    expect(result.conflicts).toBe(0)
    expect(result.hunkUpdates).toHaveLength(0)
  })
})

describe("findExistingWorkspaceFile: ancestor fallback", () => {
  const HOME = "/Users/u"

  it("finds a file at an ancestor of root when standard candidates miss", async () => {
    files.set("/Users/u/Desktop/demo/index.html", { content: "<html></html>" })
    const result = await findExistingWorkspaceFile("Desktop/demo/index.html", "/Users/u/Desktop/demo", { home: HOME })
    expect(result.uri?.fsPath).toBe("/Users/u/Desktop/demo/index.html")
    expect(result.tried).toContain("/Users/u/Desktop/demo/Desktop/demo/index.html")
    expect(result.tried).toContain("/Users/u/Desktop/demo/index.html")
  })

  it("stops the ancestor walk at the home directory", async () => {
    files.set("/Users/other/leaked.txt", { content: "secret" })
    const result = await findExistingWorkspaceFile("other/leaked.txt", "/Users/u/Desktop/demo", { home: HOME })
    expect(result.uri).toBeUndefined()
    expect(result.tried.some((p) => p.startsWith("/Users/other"))).toBe(false)
  })

  it("skips the ancestor fallback when relPath contains '..' segments", async () => {
    files.set("/etc/passwd", { content: "root:x:0:0" })
    const result = await findExistingWorkspaceFile("../../etc/passwd", "/Users/u/Desktop/demo", { home: HOME })
    expect(result.uri).toBeUndefined()
    // The ancestor walk should not have appended an /etc/passwd candidate.
    expect(result.tried.some((p) => p === "/etc/passwd")).toBe(false)
  })

  it("reports a conflict when neither the standard candidates nor the ancestor walk find the file", async () => {
    const { change, hunk } = makeChange({
      path: "Desktop/demo/index.html",
      kind: "created",
      patch: "@@ -0,0 +1,1 @@\n+hello",
    })
    const outcome = await reviewHunk(change, hunk, "accepted", { silent: true, root: "/Users/u/Desktop/demo" })
    expect(outcome.status).toBe("conflict")
  })
})

describe("findExistingWorkspaceFile: preferAbsolute (apply_patch absolute-path hint)", () => {
  it("uses the absolute hint when it resolves, bypassing the relative candidates", async () => {
    files.set("/Users/u/Desktop/demo/index.html", { content: "<html></html>" })
    const result = await findExistingWorkspaceFile(
      "Desktop/demo/index.html",
      "/Users/u/Desktop/demo",
      { home: "/Users/u", preferAbsolute: "/Users/u/Desktop/demo/index.html" },
    )
    expect(result.uri?.fsPath).toBe("/Users/u/Desktop/demo/index.html")
    // The hint is tried first.
    expect(result.tried[0]).toBe("/Users/u/Desktop/demo/index.html")
  })

  it("falls through to the workspace candidates when the absolute hint misses", async () => {
    files.set("/workspace/foo.ts", { content: "hi" })
    const result = await findExistingWorkspaceFile("foo.ts", undefined, {
      preferAbsolute: "/does/not/exist/foo.ts",
    })
    expect(result.uri?.fsPath).toBe("/workspace/foo.ts")
    expect(result.tried).toContain("/does/not/exist/foo.ts")
    expect(result.tried).toContain("/workspace/foo.ts")
  })

  it("ignores a non-absolute preferAbsolute value", async () => {
    files.set("/workspace/foo.ts", { content: "hi" })
    const result = await findExistingWorkspaceFile("foo.ts", undefined, {
      preferAbsolute: "relative/foo.ts",
    })
    expect(result.uri?.fsPath).toBe("/workspace/foo.ts")
    expect(result.tried).not.toContain("relative/foo.ts")
  })

  it("Keep on a created file with absolutePath set succeeds when the absolute file exists", async () => {
    files.set("/Users/u/somewhere/index.html", { content: "<html></html>" })
    const change: ReviewChange = {
      source: "src1",
      path: "Desktop/demo/index.html",
      kind: "created",
      additions: 1,
      deletions: 0,
      patch: "@@ -0,0 +1,1 @@\n+<html></html>",
      absolutePath: "/Users/u/somewhere/index.html",
    }
    const hunk = splitReviewDiff(change.patch).hunks[0]!
    const outcome = await reviewHunk(change, hunk, "accepted", { silent: true, root: "/workspace" })
    expect(outcome.status).toBe("applied")
  })
})

describe("acceptHunk: pure-deletion verification", () => {
  it("Keep on a pure deletion applies when the removed lines are gone", async () => {
    files.set("/workspace/foo.ts", { content: "alpha\ngamma\n" })
    const { change, hunk } = makeChange({
      path: "foo.ts",
      patch: "@@ -2,1 +1,0 @@\n-beta",
    })
    const outcome = await reviewHunk(change, hunk, "accepted", { silent: true })
    expect(outcome.status).toBe("applied")
  })

  it("Keep on a pure deletion conflicts when the removed lines are still present", async () => {
    files.set("/workspace/foo.ts", { content: "alpha\nbeta\ngamma\n" })
    const { change, hunk } = makeChange({
      path: "foo.ts",
      patch: "@@ -2,1 +1,0 @@\n-beta",
    })
    const outcome = await reviewHunk(change, hunk, "accepted", { silent: true })
    expect(outcome.status).toBe("conflict")
    if (outcome.status === "conflict") {
      expect(outcome.reason).toMatch(/removed lines are still present/i)
    }
  })
})

function offsetFromPosition(text: string, pos: { line: number; character: number }): number {
  let offset = 0
  let line = 0
  while (line < pos.line && offset <= text.length) {
    const idx = text.indexOf("\n", offset)
    if (idx < 0) return text.length
    offset = idx + 1
    line++
  }
  return Math.min(offset + pos.character, text.length)
}
