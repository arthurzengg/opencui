import { describe, it, expect } from "vitest"
import { reviewChanges } from "../../src/chat/review-changes"
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
    const changes = reviewChanges(messages)
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
    const changes = reviewChanges(messages)
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
    const changes = reviewChanges(messages)
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
    const changes = reviewChanges(messages)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.actors).toEqual([{ kind: "main" }])
  })
})

describe("Host/webview aggregation consistency", () => {
  // Run the same input through both pipelines and assert the outputs match.
  // Webview uses `turnChanges`; host uses `reviewChanges`. They MUST agree
  // because actions (Keep/Undo by path) cross the boundary.
  function eqOnPaths(a: { path: string; additions: number; deletions: number }[],
                    b: { path: string; additions: number; deletions: number }[]) {
    const norm = (xs: typeof a) =>
      xs.map((x) => ({ path: x.path, additions: x.additions, deletions: x.deletions }))
        .sort((p, q) => p.path.localeCompare(q.path))
    expect(norm(a)).toEqual(norm(b))
  }

  it("agrees on the per-file row count + sums", () => {
    const messages: ChatMessage[] = [
      assistant("m1", [
        toolBlock({ callID: "c1", filePath: "src/a.ts", patch: "@@\n+x\n+y", additions: 2 }),
        toolBlock({ callID: "c2", filePath: "src/b.ts", patch: "@@\n+z", additions: 1 }),
        toolBlock({ callID: "c3", filePath: "src/a.ts", patch: "@@\n-q", additions: 0, deletions: 1 }),
      ]),
    ]
    const host = reviewChanges(messages)
    const web = turnChanges(messages)
    eqOnPaths(host, web)
    // And both should produce two rows: a.ts and b.ts.
    expect(host).toHaveLength(2)
    expect(web).toHaveLength(2)
  })

  it("agrees in the presence of subagent attribution", () => {
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
    const host = reviewChanges(messages)
    const web = turnChanges(messages)
    eqOnPaths(host, web)
    expect(host[0]!.actors!.length).toBe(2)
    expect(web[0]!.actors!.length).toBe(2)
  })

  it("agrees for a pure-deletion patch", () => {
    const patch = ["@@ -1,3 +1,1 @@", " ctx", "-removed1", "-removed2"].join("\n")
    const messages: ChatMessage[] = [
      assistant("m1", [
        toolBlock({ callID: "c1", filePath: "src/a.ts", patch, additions: 0, deletions: 2 }),
      ]),
    ]
    const host = reviewChanges(messages)
    const web = turnChanges(messages)
    eqOnPaths(host, web)
  })

  it("agrees on a created-file row", () => {
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
    const host = reviewChanges(messages)
    const web = turnChanges(messages)
    eqOnPaths(host, web)
    expect(host[0]!.kind).toBe("created")
    expect(web[0]!.kind).toBe("created")
  })

  it("agrees that subagent + main edits collapse onto one row, not two", () => {
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
    const host = reviewChanges(messages)
    const web = turnChanges(messages)
    expect(host).toHaveLength(1)
    expect(web).toHaveLength(1)
    eqOnPaths(host, web)
  })
})
