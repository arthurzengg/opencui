import { describe, it, expect, beforeEach, vi } from "vitest"
import * as vscode from "vscode"
import { buildPrompt, readMentions } from "../../src/chat/view"

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
})

describe("readMentions", () => {
  beforeEach(() => {
    vi.mocked(vscode.workspace.fs.readFile).mockReset()
  })

  it("returns undefined for empty mentions", async () => {
    expect(await readMentions(undefined)).toBeUndefined()
    expect(await readMentions([])).toBeUndefined()
  })

  it("returns a fenced block per file with the @path header", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      new TextEncoder().encode("export const x = 1\n"),
    )
    const out = await readMentions(["src/foo.ts"])
    expect(out).toContain("Files attached:")
    expect(out).toContain("@src/foo.ts")
    expect(out).toContain("```ts")
    expect(out).toContain("export const x = 1")
  })

  it("dedups repeated mention paths", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
      new TextEncoder().encode("hello"),
    )
    const out = await readMentions(["src/foo.ts", "src/foo.ts"])
    expect(out).toBeDefined()
    // Only one occurrence of the @path header
    const matches = out!.match(/@src\/foo\.ts/g)
    expect(matches).toHaveLength(1)
  })

  it("skips files that fail to read but keeps going", async () => {
    vi.mocked(vscode.workspace.fs.readFile)
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce(new TextEncoder().encode("good"))
    const out = await readMentions(["bad.ts", "good.ts"])
    expect(out).toBeDefined()
    expect(out).toContain("@good.ts")
    expect(out).not.toContain("@bad.ts")
  })

  it("returns undefined when every read fails", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(new Error("nope"))
    const out = await readMentions(["x.ts", "y.ts"])
    expect(out).toBeUndefined()
  })

  it("picks a sensible fence language from extension", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      new TextEncoder().encode("body { color: red; }"),
    )
    const out = await readMentions(["styles.css"])
    expect(out).toContain("```css")
  })
})
