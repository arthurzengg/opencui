import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as vscode from "vscode"
import { buildPrompt, readMentions } from "../../src/chat/prompt-builder"
import type { WorkspaceRoot } from "../../src/workspace-root"

const FAKE_ROOT: WorkspaceRoot = {
  uri: { fsPath: "/repo", scheme: "file" } as unknown as vscode.Uri,
  fsPath: "/repo",
  name: "repo",
  index: 0,
  isDefault: true,
}

describe("buildPrompt", () => {
  it("returns the user text when there is no editor context or mentions", () => {
    expect(buildPrompt("hello", {})).toBe("hello")
  })

  it("prepends Context line for editor file with no selection", () => {
    const out = buildPrompt("describe", { relativePath: "src/foo.ts", language: "ts" })
    expect(out).toContain("Context: src/foo.ts")
    expect(out).toContain("describe")
    expect(out.indexOf("Context: src/foo.ts")).toBeLessThan(out.indexOf("describe"))
  })

  it("includes selection text in a fenced code block", () => {
    const out = buildPrompt("explain", {
      relativePath: "src/foo.ts",
      language: "ts",
      selection: { startLine: 3, endLine: 5, text: "const x = 1\nconst y = 2" },
    })
    expect(out).toContain("Selection (lines 3-5):")
    expect(out).toContain("```ts")
    expect(out).toContain("const x = 1")
    expect(out).toContain("```")
  })

  it("prepends mentionBlock before editor context", () => {
    const out = buildPrompt(
      "compare them",
      { relativePath: "src/foo.ts" },
      "Files attached:\n@src/bar.ts\n```ts\nfoo\n```",
    )
    expect(out.indexOf("Files attached:")).toBeLessThan(out.indexOf("Context: src/foo.ts"))
    expect(out.indexOf("Context: src/foo.ts")).toBeLessThan(out.indexOf("compare them"))
  })

  it("works with mentions but no editor context", () => {
    const out = buildPrompt("explain", {}, "Files attached:\n@a.ts\n```ts\nx\n```")
    expect(out).toContain("Files attached:")
    expect(out).toContain("explain")
  })

  it("prepends a workspace declaration when a root is provided", () => {
    const out = buildPrompt("hi", { relativePath: "src/foo.ts" }, undefined, FAKE_ROOT)
    expect(out.indexOf("Workspace:")).toBe(0)
    expect(out).toContain("- Name: repo")
    expect(out).toContain("- Root: /repo")
    // Workspace block precedes the editor context line.
    expect(out.indexOf("Workspace:")).toBeLessThan(out.indexOf("Context: src/foo.ts"))
  })

  it("omits the workspace declaration when no root is provided", () => {
    const out = buildPrompt("hi", { relativePath: "src/foo.ts" }, undefined, undefined)
    expect(out).not.toContain("Workspace:")
  })
})

describe("readMentions", () => {
  beforeEach(() => {
    vi.mocked(vscode.workspace.fs.readFile).mockReset()
  })

  it("returns empty state for empty mentions", async () => {
    const a = await readMentions(undefined)
    expect(a.block).toBeUndefined()
    expect(a.bytes).toEqual({})
    expect(a.capped).toEqual([])
    expect(a.failed).toEqual([])
    const b = await readMentions([])
    expect(b.block).toBeUndefined()
  })

  it("returns a fenced block per file with the @path header", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      new TextEncoder().encode("export const x = 1\n"),
    )
    const out = await readMentions(["src/foo.ts"])
    expect(out.block).toContain("Files attached:")
    expect(out.block).toContain("@src/foo.ts")
    expect(out.block).toContain("```ts")
    expect(out.block).toContain("export const x = 1")
    expect(out.bytes["src/foo.ts"]).toMatchObject({
      included: expect.any(Number),
      original: expect.any(Number),
    })
  })

  it("dedups repeated mention paths", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
      new TextEncoder().encode("hello"),
    )
    const out = await readMentions(["src/foo.ts", "src/foo.ts"])
    expect(out.block).toBeDefined()
    const matches = out.block!.match(/@src\/foo\.ts/g)
    expect(matches).toHaveLength(1)
  })

  it("records failed reads in `failed`", async () => {
    vi.mocked(vscode.workspace.fs.readFile)
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce(new TextEncoder().encode("good"))
    const out = await readMentions(["bad.ts", "good.ts"])
    expect(out.block).toContain("@good.ts")
    expect(out.block).not.toContain("@bad.ts")
    expect(out.failed).toEqual(["bad.ts"])
    expect(out.bytes["good.ts"]).toBeDefined()
    expect(out.bytes["bad.ts"]).toBeUndefined()
  })

  it("returns no block when every read fails", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(new Error("nope"))
    const out = await readMentions(["x.ts", "y.ts"])
    expect(out.block).toBeUndefined()
    expect(out.failed).toEqual(["x.ts", "y.ts"])
  })

  it("picks a sensible fence language from extension", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      new TextEncoder().encode("body { color: red; }"),
    )
    const out = await readMentions(["styles.css"])
    expect(out.block).toContain("```css")
  })
})

describe("readMentions: multi-root workspaces", () => {
  // asRelativePath prefixes the owning folder's name in multi-root setups,
  // so a mention arrives as "folderB/src/x.ts". The old code resolved it
  // against folder 0 only → /workspace/folderB/src/x.ts → ENOENT, and the
  // file silently never reached the prompt.
  const original = vscode.workspace.workspaceFolders

  beforeEach(() => {
    vi.mocked(vscode.workspace.fs.readFile).mockReset()
    ;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file("/repos/folderA"), name: "folderA", index: 0 },
      { uri: vscode.Uri.file("/repos/folderB"), name: "folderB", index: 1 },
    ]
  })

  afterEach(() => {
    ;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = original
  })

  it("resolves a folder-prefixed mention inside the owning folder", async () => {
    const attempted: string[] = []
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async (uri: vscode.Uri) => {
      attempted.push(uri.fsPath)
      if (uri.fsPath === "/repos/folderB/src/x.ts") {
        return new TextEncoder().encode("const b = 2\n")
      }
      throw new Error("ENOENT")
    })
    const out = await readMentions(["folderB/src/x.ts"])
    expect(out.failed).toEqual([])
    expect(out.block).toContain("@folderB/src/x.ts")
    expect(out.block).toContain("const b = 2")
    expect(attempted).toContain("/repos/folderB/src/x.ts")
  })

  it("prefers the exact path over the folder-name-stripped variant", async () => {
    // folderA really contains a subdirectory named folderA — the exact path
    // must win over stripping the prefix.
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async (uri: vscode.Uri) => {
      if (uri.fsPath === "/repos/folderA/folderA/x.ts") {
        return new TextEncoder().encode("nested")
      }
      if (uri.fsPath === "/repos/folderA/x.ts") {
        return new TextEncoder().encode("stripped")
      }
      throw new Error("ENOENT")
    })
    const out = await readMentions(["folderA/x.ts"])
    expect(out.block).toContain("nested")
    expect(out.block).not.toContain("stripped")
  })

  it("records the mention as failed when no folder has the file", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(new Error("ENOENT"))
    const out = await readMentions(["folderB/missing.ts"])
    expect(out.failed).toEqual(["folderB/missing.ts"])
    expect(out.block).toBeUndefined()
  })
})
