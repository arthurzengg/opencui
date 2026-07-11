import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as vscode from "vscode"
import {
  attachableConversationIDs,
  buildPrompt,
  readMentions,
  formatConversationContext,
  readConversationMentions,
} from "../../src/chat/prompt-builder"
import type { WorkspaceRoot } from "../../src/workspace-root"
import type { ChatMessage, ToolUpdate } from "../../src/protocol"

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

function msg(role: "user" | "assistant", text: string, id = "m"): ChatMessage {
  return { id, role, blocks: [{ type: "text", text }] }
}

const bytesOf = (s: string) => Buffer.byteLength(s, "utf8")

describe("formatConversationContext", () => {
  it("includes every message fenced under the header when the budget allows", () => {
    const out = formatConversationContext(
      "Fix the picker",
      [msg("user", "hello"), msg("assistant", "hi there"), msg("user", "thanks")],
      100_000,
    )!
    expect(out.truncated).toBe(false)
    const lines = out.text.split("\n")
    expect(lines[0]).toBe('Past conversation "Fix the picker":')
    expect(lines[1]).toBe("```")
    expect(lines.at(-1)).toBe("```")
    expect(out.text).toContain("User: hello")
    expect(out.text).toContain("Assistant: hi there")
    expect(out.text).toContain("User: thanks")
    expect(out.text).not.toContain("omitted")
    expect(bytesOf(out.text)).toBe(out.originalBytes)
  })

  it("keeps the first message plus a contiguous tail and marks the gap", () => {
    const messages = [
      msg("user", "the original intent message"),
      ...Array.from({ length: 40 }, (_, i) => msg("assistant", `middle turn ${i} ${"x".repeat(200)}`)),
      msg("assistant", "the final conclusion"),
    ]
    const budget = 2_000
    const out = formatConversationContext("T", messages, budget)!
    expect(out.truncated).toBe(true)
    expect(bytesOf(out.text)).toBeLessThanOrEqual(budget)
    expect(out.text).toContain("User: the original intent message")
    expect(out.text).toContain("Assistant: the final conclusion")
    const marker = out.text.match(/\[\.\.\. (\d+) messages omitted\]/)
    expect(marker).not.toBeNull()
    const omitted = Number(marker![1])
    const note = out.text.match(/\(first message \+ last (\d+) of (\d+) total\)/)
    expect(note).not.toBeNull()
    expect(Number(note![2])).toBe(42)
    // Anchor + omitted + tail accounts for every message exactly once.
    expect(1 + omitted + Number(note![1])).toBe(42)
    // The tail is the most recent turns — the gap sits in the middle.
    expect(out.text).not.toContain("middle turn 0 ")
  })

  it("never exceeds the budget or splits characters on CJK content", () => {
    const messages = Array.from({ length: 30 }, (_, i) =>
      msg(i % 2 === 0 ? "user" : "assistant", `第${i}轮：${"这是一段很长的中文内容。".repeat(20)}`),
    )
    const budget = 3_000
    const out = formatConversationContext("中文对话", messages, budget)!
    expect(bytesOf(out.text)).toBeLessThanOrEqual(budget)
    expect(out.text).not.toContain("�")
    expect(out.truncated).toBe(true)
  })

  it("caps a single oversized message instead of letting it evict the rest", () => {
    const messages = [
      msg("user", "short question"),
      msg("assistant", "line\n".repeat(12_000)),
      msg("user", "follow-up"),
      msg("assistant", "final answer"),
    ]
    const budget = 100_000
    const out = formatConversationContext("T", messages, budget)!
    expect(out.text).toContain("[message truncated]")
    expect(out.text).toContain("User: short question")
    expect(out.text).toContain("User: follow-up")
    expect(out.text).toContain("Assistant: final answer")
    expect(out.truncated).toBe(true)
    // The giant message was held to ~25% of the budget.
    expect(bytesOf(out.text)).toBeLessThan(30_000)
  })

  it("uses a fence longer than any backtick run in the transcript", () => {
    const out = formatConversationContext(
      "T",
      [msg("assistant", "use this:\n```ts\nconst x = 1\n```")],
      100_000,
    )!
    const lines = out.text.split("\n")
    expect(lines[1]).toBe("````")
    expect(lines.at(-1)).toBe("````")
    expect(out.text).toContain("```ts")
  })

  it("flattens tool and patch blocks to one-line summaries", () => {
    const update: ToolUpdate = { callID: "c1", tool: "bash", status: "completed", title: "npm test" }
    const messages: ChatMessage[] = [
      msg("user", "run the tests"),
      {
        id: "a1",
        role: "assistant",
        blocks: [
          { type: "tool", update },
          { type: "patch", files: ["src/a.ts", "src/b.ts"] },
          { type: "text", text: "done" },
        ],
      },
    ]
    const out = formatConversationContext("T", messages, 100_000)!
    expect(out.text).toContain("[bash: npm test]")
    expect(out.text).toContain("[patched src/a.ts, src/b.ts]")
    expect(out.text).toContain("done")
  })

  it("returns undefined when not even the first message fits", () => {
    const out = formatConversationContext("T", [msg("user", "hello world")], 40)
    expect(out).toBeUndefined()
  })

  it("returns a header-only block for a conversation with no renderable parts", () => {
    const messages: ChatMessage[] = [{ id: "m1", role: "assistant", blocks: [] }]
    const out = formatConversationContext("Empty", messages, 100_000)!
    expect(out.text).toBe('Past conversation "Empty":')
    expect(out.truncated).toBe(false)
  })
})

describe("attachableConversationIDs", () => {
  it("keeps each past conversation once, in chip order", () => {
    expect(
      attachableConversationIDs(
        [
          { label: "chat:A", id: "a" },
          { label: "chat:Self", id: "current" },
          { label: "chat:A_2", id: "a" },
          { label: "chat:B", id: "b" },
        ],
        "current",
      ),
    ).toEqual(["a", "b"])
  })

  it("returns empty for undefined and for self-only mentions", () => {
    expect(attachableConversationIDs(undefined, "current")).toEqual([])
    expect(attachableConversationIDs([{ label: "chat:Me", id: "current" }], "current")).toEqual([])
  })
})

describe("readConversationMentions", () => {
  const conversations: Record<string, ChatMessage[]> = {
    a: [msg("user", "first question"), msg("assistant", "first answer")],
    b: [msg("user", "second question"), msg("assistant", "second answer")],
  }
  const getMessages = (id: string) => conversations[id]
  const getTitle = (id: string) => (id === "a" ? "Chat A" : id === "b" ? "Chat B" : undefined)

  it("returns empty state for no ids", () => {
    const out = readConversationMentions(undefined, getMessages, getTitle)
    expect(out.block).toBeUndefined()
    expect(out.bytes).toEqual({})
  })

  it("joins conversations with a blank line and records exact byte accounting", () => {
    const out = readConversationMentions(["a", "b"], getMessages, getTitle)
    expect(out.block).toContain('Past conversation "Chat A"')
    expect(out.block).toContain('Past conversation "Chat B"')
    expect(out.block!.split("\n\n")).toHaveLength(2)
    expect(out.bytes.a).toMatchObject({ truncated: false })
    expect(out.bytes.a!.included).toBe(out.bytes.a!.original)
    expect(out.capped).toEqual([])
    expect(out.failed).toEqual([])
  })

  it("dedups ids and records unknown conversations as failed", () => {
    const out = readConversationMentions(["a", "a", "missing"], getMessages, getTitle)
    expect(out.block!.match(/Chat A/g)).toHaveLength(1)
    expect(out.failed).toEqual(["missing"])
  })

  it("records a conversation as capped when the budget cannot fit its first message", () => {
    const out = readConversationMentions(["a"], getMessages, getTitle, 30)
    expect(out.capped).toEqual(["a"])
    expect(out.bytes.a).toBeUndefined()
    expect(out.block).toBeUndefined()
  })

  it("gives earlier mentions budget priority and never exceeds the total", () => {
    const big: Record<string, ChatMessage[]> = {
      one: Array.from({ length: 12 }, (_, i) => msg("user", `one turn ${i} ${"alpha ".repeat(20)}`)),
      two: Array.from({ length: 12 }, (_, i) => msg("user", `two turn ${i} ${"beta ".repeat(20)}`)),
    }
    const budget = 900
    const out = readConversationMentions(["one", "two"], (id) => big[id], (id) => id, budget)
    expect(out.bytes.one).toBeDefined()
    const included = Object.values(out.bytes).reduce((sum, b) => sum + b.included, 0)
    expect(included).toBeLessThanOrEqual(budget)
    // Every id lands in exactly one bucket.
    expect(Object.keys(out.bytes).length + out.capped.length + out.failed.length).toBe(2)
  })

  it("stays within the total budget when the first conversation is truncated", () => {
    const big: Record<string, ChatMessage[]> = {
      long: Array.from({ length: 50 }, (_, i) => msg("user", `turn ${i} ${"content ".repeat(50)}`)),
    }
    const budget = 2_500
    const out = readConversationMentions(["long"], (id) => big[id], () => "Long chat", budget)
    expect(out.bytes.long).toBeDefined()
    expect(out.bytes.long!.truncated).toBe(true)
    expect(out.bytes.long!.included).toBeLessThanOrEqual(budget)
    expect(out.bytes.long!.original).toBeGreaterThan(budget)
  })
})
