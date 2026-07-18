import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"
import { rankHits, dirEntriesFrom, initFileSearch, searchWorkspaceFiles, listWorkspaceDir } from "../../src/file-search"

const fixtures = [
  { path: "src/foo.ts", name: "foo.ts" },
  { path: "src/foo/index.ts", name: "index.ts" },
  { path: "src/bar/foo.tsx", name: "foo.tsx" },
  { path: "lib/utils/foo-bar.ts", name: "foo-bar.ts" },
  { path: "src/bar.ts", name: "bar.ts" },
  { path: "deep/very/long/path/to/baz.ts", name: "baz.ts" },
]

describe("rankHits", () => {
  it("returns the input order for an empty query (capped)", () => {
    const out = rankHits(fixtures, "")
    expect(out.map((h) => h.path)).toEqual(fixtures.map((h) => h.path))
  })

  it("ranks exact basename match first", () => {
    const out = rankHits(fixtures, "foo.ts")
    expect(out[0]?.path).toBe("src/foo.ts")
  })

  it("ranks basename prefix match before substring matches", () => {
    const out = rankHits(fixtures, "foo")
    // "foo.ts" and "foo.tsx" and "foo-bar.ts" all start with foo
    const prefixOrder = out.slice(0, 3).map((h) => h.name)
    expect(prefixOrder).toContain("foo.ts")
    expect(prefixOrder).toContain("foo.tsx")
    expect(prefixOrder).toContain("foo-bar.ts")
    // index.ts (path contains foo but basename doesn't start with foo) comes later
    const indexIdx = out.findIndex((h) => h.path === "src/foo/index.ts")
    expect(indexIdx).toBeGreaterThan(2)
  })

  it("falls back to path substring match", () => {
    const out = rankHits(fixtures, "deep/very")
    expect(out[0]?.path).toBe("deep/very/long/path/to/baz.ts")
  })

  it("breaks ties by shorter path", () => {
    const entries = [
      { path: "a/very/long/path/foo.ts", name: "foo.ts" },
      { path: "x/foo.ts", name: "foo.ts" },
    ]
    const out = rankHits(entries, "foo.ts")
    expect(out[0]?.path).toBe("x/foo.ts")
  })

  it("excludes entries that don't match the query at all", () => {
    const out = rankHits(fixtures, "xyz-not-found")
    expect(out).toEqual([])
  })

  it("is case-insensitive", () => {
    const out = rankHits(fixtures, "FOO")
    expect(out.length).toBeGreaterThan(0)
    expect(out[0]?.name.toLowerCase()).toContain("foo")
  })

  it("handles whitespace-only query as empty", () => {
    const out = rankHits(fixtures, "   ")
    expect(out.map((h) => h.path)).toEqual(fixtures.map((h) => h.path))
  })

  describe("recent-tabs boost", () => {
    it("empty query: recently-opened paths sort to the top in tab order", () => {
      const out = rankHits(fixtures, "", ["deep/very/long/path/to/baz.ts", "src/bar.ts"])
      expect(out[0]?.path).toBe("deep/very/long/path/to/baz.ts")
      expect(out[1]?.path).toBe("src/bar.ts")
    })

    it("non-empty query: within the same score tier, recent files come first", () => {
      const entries = [
        { path: "lib/foo.ts", name: "foo.ts" },
        { path: "src/foo.ts", name: "foo.ts" },
      ]
      // Both are exact-basename matches → same score tier. Without recent, the
      // shorter path wins. With recent, the recent one wins regardless of length.
      const out = rankHits(entries, "foo.ts", ["lib/foo.ts"])
      expect(out[0]?.path).toBe("lib/foo.ts")
    })

    it("recent files that don't match the query are NOT included", () => {
      const out = rankHits(fixtures, "baz", ["src/foo.ts"])
      // "src/foo.ts" doesn't match query "baz" → excluded despite being recent
      expect(out.every((h) => h.path !== "src/foo.ts")).toBe(true)
      expect(out[0]?.path).toBe("deep/very/long/path/to/baz.ts")
    })

    it("recency only re-orders within a score tier — higher tiers still beat recent", () => {
      const entries = [
        { path: "a/foo.ts", name: "foo.ts" }, // exact basename match, NOT recent
        { path: "b/foo-bar.ts", name: "foo-bar.ts" }, // basename prefix match, IS recent
      ]
      const out = rankHits(entries, "foo.ts", ["b/foo-bar.ts"])
      // Even though foo-bar.ts is recent, foo.ts has the better score tier.
      expect(out[0]?.path).toBe("a/foo.ts")
    })

    it("duplicate recent entries are deduped to their first index", () => {
      const out = rankHits(fixtures, "", ["src/foo.ts", "src/foo.ts", "src/bar.ts"])
      expect(out[0]?.path).toBe("src/foo.ts")
      expect(out[1]?.path).toBe("src/bar.ts")
    })
  })
})

describe("cache invalidation", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function uri(p: string) {
    return vscode.Uri.file(`/workspace/${p}`)
  }

  it("drops the cached index when the watcher fires create/delete", async () => {
    const created: Array<() => void> = []
    const deleted: Array<() => void> = []
    vi.spyOn(vscode.workspace, "createFileSystemWatcher").mockReturnValue({
      onDidCreate: (cb: () => void) => (created.push(cb), { dispose: vi.fn() }),
      onDidDelete: (cb: () => void) => (deleted.push(cb), { dispose: vi.fn() }),
      onDidChange: () => ({ dispose: vi.fn() }),
      dispose: vi.fn(),
    } as unknown as vscode.FileSystemWatcher)

    const findFiles = vi.spyOn(vscode.workspace, "findFiles")
    findFiles.mockResolvedValue([uri("a.ts")] as never)

    initFileSearch({ subscriptions: [] } as unknown as vscode.ExtensionContext)

    const first = await searchWorkspaceFiles("")
    expect(first.map((h) => h.path)).toEqual(["a.ts"])

    // A second file now exists, but within the 30s TTL the cache still serves
    // the stale listing.
    findFiles.mockResolvedValue([uri("a.ts"), uri("b.ts")] as never)
    const cached = await searchWorkspaceFiles("")
    expect(cached.map((h) => h.path)).toEqual(["a.ts"])

    // The watcher fires → cache is dropped → the fresh listing is loaded.
    deleted.forEach((cb) => cb())
    const fresh = await searchWorkspaceFiles("")
    expect(fresh.map((h) => h.path)).toEqual(["a.ts", "b.ts"])
    expect(findFiles).toHaveBeenCalledTimes(2)
  })
})

describe("in-flight scan sharing", () => {
  function uri(p: string) {
    return vscode.Uri.file(`/workspace/${p}`)
  }

  /** Install a watcher mock, register it, and return a fn that fires cache
   *  invalidation — used to force a cold cache since the index is module state. */
  function installInvalidator(): () => void {
    const callbacks: Array<() => void> = []
    vi.spyOn(vscode.workspace, "createFileSystemWatcher").mockReturnValue({
      onDidCreate: (cb: () => void) => (callbacks.push(cb), { dispose: vi.fn() }),
      onDidDelete: (cb: () => void) => (callbacks.push(cb), { dispose: vi.fn() }),
      onDidChange: () => ({ dispose: vi.fn() }),
      dispose: vi.fn(),
    } as unknown as vscode.FileSystemWatcher)
    initFileSearch({ subscriptions: [] } as unknown as vscode.ExtensionContext)
    return () => callbacks.forEach((cb) => cb())
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("concurrent cold-cache callers share one findFiles scan", async () => {
    const invalidate = installInvalidator()
    invalidate()
    const findFiles = vi.spyOn(vscode.workspace, "findFiles").mockClear()
    let resolveScan!: (uris: vscode.Uri[]) => void
    findFiles.mockReturnValue(new Promise((r) => (resolveScan = r)) as never)

    const p1 = searchWorkspaceFiles("a")
    const p2 = searchWorkspaceFiles("")
    const p3 = listWorkspaceDir("")
    expect(findFiles).toHaveBeenCalledTimes(1)

    resolveScan([uri("a.ts"), uri("b/c.ts")])
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1.map((h) => h.path)).toEqual(["a.ts"])
    expect(r2.map((h) => h.path)).toEqual(["a.ts", "b/c.ts"])
    expect(r3).toEqual([
      { name: "b", path: "b", kind: "folder" },
      { name: "a.ts", path: "a.ts", kind: "file" },
    ])

    // The shared scan populated the cache — a follow-up call doesn't rescan.
    await searchWorkspaceFiles("")
    expect(findFiles).toHaveBeenCalledTimes(1)
  })

  it("a scan invalidated mid-flight does not publish into the cache", async () => {
    const invalidate = installInvalidator()
    invalidate()
    const findFiles = vi.spyOn(vscode.workspace, "findFiles").mockClear()
    let resolveScan!: (uris: vscode.Uri[]) => void
    findFiles.mockReturnValueOnce(new Promise((r) => (resolveScan = r)) as never)

    const stale = searchWorkspaceFiles("")
    invalidate()
    resolveScan([uri("stale.ts")])
    // The caller that started the scan still gets its listing...
    expect((await stale).map((h) => h.path)).toEqual(["stale.ts"])

    // ...but the cache stayed cold: the next call runs a fresh scan.
    findFiles.mockResolvedValue([uri("fresh.ts")] as never)
    const fresh = await searchWorkspaceFiles("")
    expect(fresh.map((h) => h.path)).toEqual(["fresh.ts"])
    expect(findFiles).toHaveBeenCalledTimes(2)
  })

  it("a failed scan clears the in-flight slot so the next call retries", async () => {
    const invalidate = installInvalidator()
    invalidate()
    const findFiles = vi.spyOn(vscode.workspace, "findFiles").mockClear()
    findFiles.mockRejectedValueOnce(new Error("boom") as never)
    await expect(searchWorkspaceFiles("")).rejects.toThrow("boom")

    findFiles.mockResolvedValue([uri("a.ts")] as never)
    const out = await searchWorkspaceFiles("")
    expect(out.map((h) => h.path)).toEqual(["a.ts"])
    expect(findFiles).toHaveBeenCalledTimes(2)
  })
})

describe("dirEntriesFrom", () => {
  it("lists root-level entries, folders first", () => {
    const out = dirEntriesFrom(fixtures, "")
    expect(out).toEqual([
      { name: "deep", path: "deep", kind: "folder" },
      { name: "lib", path: "lib", kind: "folder" },
      { name: "src", path: "src", kind: "folder" },
    ])
  })

  it("lists a folder's immediate children, folders before files, each alphabetical", () => {
    const out = dirEntriesFrom(fixtures, "src")
    expect(out).toEqual([
      { name: "bar", path: "src/bar", kind: "folder" },
      { name: "foo", path: "src/foo", kind: "folder" },
      { name: "bar.ts", path: "src/bar.ts", kind: "file" },
      { name: "foo.ts", path: "src/foo.ts", kind: "file" },
    ])
  })

  it("distinguishes a folder from a same-stem sibling file", () => {
    const out = dirEntriesFrom(fixtures, "src")
    // src/bar (folder, inferred from src/bar/foo.tsx) and src/bar.ts (file) are distinct.
    expect(out.find((e) => e.path === "src/bar")?.kind).toBe("folder")
    expect(out.find((e) => e.path === "src/bar.ts")?.kind).toBe("file")
  })

  it("returns only files when a folder has no subfolders", () => {
    expect(dirEntriesFrom(fixtures, "src/foo")).toEqual([
      { name: "index.ts", path: "src/foo/index.ts", kind: "file" },
    ])
  })

  it("tolerates a trailing slash on the dir", () => {
    expect(dirEntriesFrom(fixtures, "src/")).toEqual(dirEntriesFrom(fixtures, "src"))
  })

  it("returns empty for a folder with no matching files", () => {
    expect(dirEntriesFrom(fixtures, "does/not/exist")).toEqual([])
  })
})
