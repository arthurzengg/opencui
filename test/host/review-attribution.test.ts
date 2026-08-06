import { describe, it, expect } from "vitest"
import { turnChanges } from "../../webview/src/review-extract"
import type { ChatMessage } from "../../webview/src/protocol"

function toolBlock(opts: {
  callID?: string
  filePath: string
  patch: string
  additions?: number
  deletions?: number
  actor?: { kind: "main" | "subagent"; sessionID?: string; subagent?: string }
}) {
  return {
    type: "tool" as const,
    update: {
      callID: opts.callID ?? `c-${Math.random().toString(36).slice(2)}`,
      tool: "edit",
      status: "completed" as const,
      input: { filePath: opts.filePath },
      metadata: {
        filediff: { patch: opts.patch, additions: opts.additions ?? 1, deletions: opts.deletions ?? 0 },
      },
    },
    actor: opts.actor,
  }
}

function assistant(id: string, blocks: ReturnType<typeof toolBlock>[]): ChatMessage {
  return { id, role: "assistant", blocks: blocks as any } as ChatMessage
}

describe("ReviewChange attribution: subagent vs main", () => {
  it("records the actor of a subagent-emitted tool block in the change", () => {
    const messages = [
      assistant("m1", [
        toolBlock({
          filePath: "src/a.ts",
          patch: "@@ -1 +1 @@\n+x",
          actor: { kind: "subagent", sessionID: "ses_child_1", subagent: "explore" },
        }),
      ]),
    ]
    const changes = turnChanges(messages)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.actors).toEqual([
      { kind: "subagent", sessionID: "ses_child_1", subagent: "explore" },
    ])
  })

  it("merges actors when main and subagent edit the same file", () => {
    const messages = [
      assistant("m1", [
        toolBlock({
          callID: "c-main",
          filePath: "src/a.ts",
          patch: "@@ -1 +1 @@\n+x",
          actor: { kind: "main" },
        }),
        toolBlock({
          callID: "c-sub",
          filePath: "src/a.ts",
          patch: "@@ -2 +2 @@\n+y",
          actor: { kind: "subagent", sessionID: "ses_child_1", subagent: "hephaestus" },
        }),
      ]),
    ]
    const changes = turnChanges(messages)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.actors).toEqual(
      expect.arrayContaining([
        { kind: "main" },
        { kind: "subagent", sessionID: "ses_child_1", subagent: "hephaestus" },
      ]),
    )
    // Stats sum across both contributors
    expect(changes[0]!.additions).toBe(2)
  })

  it("dedupes identical actors across multiple subagent edits", () => {
    const messages = [
      assistant("m1", [
        toolBlock({
          callID: "c1",
          filePath: "src/a.ts",
          patch: "@@ -1 +1 @@\n+x",
          actor: { kind: "subagent", sessionID: "ses_child_1", subagent: "explore" },
        }),
        toolBlock({
          callID: "c2",
          filePath: "src/a.ts",
          patch: "@@ -3 +3 @@\n+y",
          actor: { kind: "subagent", sessionID: "ses_child_1", subagent: "explore" },
        }),
      ]),
    ]
    const changes = turnChanges(messages)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.actors).toHaveLength(1)
  })

  it("treats a missing actor as main (backward-compatible)", () => {
    const messages = [
      assistant("m1", [
        toolBlock({
          filePath: "src/a.ts",
          patch: "@@ -1 +1 @@\n+x",
          // no actor field
        }),
      ]),
    ]
    const changes = turnChanges(messages)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.actors).toEqual([{ kind: "main" }])
  })
})

// Was a host-vs-webview equality suite; both sides now import this one
// function, so it pins the aggregation shape Keep/Undo-by-path acts on.
describe("turn aggregation shape", () => {
  const rows = (changes: { path: string; additions: number; deletions: number }[]) =>
    changes
      .map((c) => ({ path: c.path, additions: c.additions, deletions: c.deletions }))
      .sort((p, q) => p.path.localeCompare(q.path))

  it("emits one row per file with stats summed across that file's tool calls", () => {
    const messages: ChatMessage[] = [
      assistant("m1", [
        toolBlock({ callID: "c1", filePath: "src/a.ts", patch: "@@\n+x\n+y", additions: 2 }),
        toolBlock({ callID: "c2", filePath: "src/b.ts", patch: "@@\n+z", additions: 1 }),
        toolBlock({ callID: "c3", filePath: "src/a.ts", patch: "@@\n-q", additions: 0, deletions: 1 }),
      ]),
    ]
    expect(rows(turnChanges(messages))).toEqual([
      { path: "src/a.ts", additions: 2, deletions: 1 },
      { path: "src/b.ts", additions: 1, deletions: 0 },
    ])
  })

  it("keeps one row when a subagent and main both edit the same file", () => {
    const messages: ChatMessage[] = [
      assistant("m1", [
        toolBlock({
          callID: "c1",
          filePath: "src/a.ts",
          patch: "@@\n+x",
          actor: { kind: "subagent", sessionID: "ses_child_1", subagent: "explore" },
        }),
        toolBlock({
          callID: "c2",
          filePath: "src/a.ts",
          patch: "@@\n+y",
          actor: { kind: "main" },
        }),
      ]),
    ]
    const changes = turnChanges(messages)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.actors!.length).toBe(2)
  })

  it("reports a pure-deletion patch as an update, not a create", () => {
    const patch = ["@@ -1,3 +1,1 @@", " ctx", "-removed1", "-removed2"].join("\n")
    const messages: ChatMessage[] = [
      assistant("m1", [
        toolBlock({ callID: "c1", filePath: "src/a.ts", patch, additions: 0, deletions: 2 }),
      ]),
    ]
    const changes = turnChanges(messages)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.kind).toBe("updated")
    expect(rows(changes)).toEqual([{ path: "src/a.ts", additions: 0, deletions: 2 }])
  })

  it("marks a write to a non-existent file as created", () => {
    const messages: ChatMessage[] = [
      {
        id: "m1",
        role: "assistant",
        blocks: [
          {
            type: "tool",
            update: {
              callID: "c1",
              tool: "write",
              status: "completed",
              input: { filePath: "new.ts", content: "a\nb" },
              metadata: { exists: false },
            },
          },
        ],
      } as ChatMessage,
    ]
    const changes = turnChanges(messages)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.kind).toBe("created")
  })

  it("collapses edits to one file onto a single row across separate turns", () => {
    const messages: ChatMessage[] = [
      assistant("m1", [
        toolBlock({
          callID: "c1",
          filePath: "src/file.ts",
          patch: "@@\n+main",
          actor: { kind: "main" },
        }),
      ]),
      assistant("m2", [
        toolBlock({
          callID: "c2",
          filePath: "src/file.ts",
          patch: "@@\n+sub",
          actor: { kind: "subagent", sessionID: "ses_child_x", subagent: "explore" },
        }),
      ]),
    ]
    const changes = turnChanges(messages)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.path).toBe("src/file.ts")
  })
})
