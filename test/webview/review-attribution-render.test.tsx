import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { ReviewPanel } from "../../webview/src/components/ReviewPanel"
import type { Message } from "../../webview/src/hooks/useChatState"

afterEach(cleanup)

function toolBlock(opts: {
  callID: string
  filePath: string
  patch: string
  additions?: number
  actor?: { kind: "main" | "subagent"; sessionID?: string; subagent?: string }
}) {
  return {
    type: "tool" as const,
    update: {
      callID: opts.callID,
      tool: "edit",
      status: "completed" as const,
      input: { filePath: opts.filePath },
      metadata: {
        filediff: { patch: opts.patch, additions: opts.additions ?? 1, deletions: 0 },
      },
    },
    actor: opts.actor,
  }
}

function assistant(id: string, blocks: ReturnType<typeof toolBlock>[]): Message {
  return { id, role: "assistant", blocks: blocks as any } as unknown as Message
}

// Review row should be filename-only — attribution lives in the row's
// title tooltip, NEVER as a visible inline label that pushes the file name
// down or clutters the card.
describe("ReviewPanel: subagent attribution stays on the tooltip", () => {
  it("does not render an inline subagent label even when a child session produced the change", () => {
    const messages = [
      assistant("m1", [
        toolBlock({
          callID: "c-sub",
          filePath: "src/foo.ts",
          patch: "@@\n+x",
          actor: { kind: "subagent", sessionID: "ses_child_1", subagent: "explore" },
        }),
      ]),
    ]
    const { container } = render(<ReviewPanel messages={messages} reviewedHunks={{}} />)
    // No `.review-file-actor` element — the old badge is gone.
    expect(container.querySelector(".review-file-actor")).toBeNull()
    // The row title tooltip still carries the attribution so power users can hover.
    const head = container.querySelector(".review-head") as HTMLElement
    expect(head.title).toContain("Modified by: explore")
  })

  it("keeps tooltip clean (just the path) for main-agent changes", () => {
    const messages = [
      assistant("m1", [
        toolBlock({
          callID: "c-main",
          filePath: "src/foo.ts",
          patch: "@@\n+x",
        }),
      ]),
    ]
    const { container } = render(<ReviewPanel messages={messages} reviewedHunks={{}} />)
    expect(container.querySelector(".review-file-actor")).toBeNull()
    const head = container.querySelector(".review-head") as HTMLElement
    expect(head.title).toBe("src/foo.ts")
  })

  it("lists multiple subagents in the tooltip when more than one touched the file", () => {
    const messages = [
      assistant("m1", [
        toolBlock({
          callID: "c1",
          filePath: "src/foo.ts",
          patch: "@@\n+x",
          actor: { kind: "subagent", sessionID: "ses_child_1", subagent: "explore" },
        }),
        toolBlock({
          callID: "c2",
          filePath: "src/foo.ts",
          patch: "@@\n+y",
          actor: { kind: "subagent", sessionID: "ses_child_2", subagent: "hephaestus" },
        }),
      ]),
    ]
    const { container } = render(<ReviewPanel messages={messages} reviewedHunks={{}} />)
    const head = container.querySelector(".review-head") as HTMLElement
    expect(head.title).toContain("explore")
    expect(head.title).toContain("hephaestus")
  })

  it("still collapses main + subagent edits onto one row (no duplicate visible attribution)", () => {
    const messages = [
      assistant("m1", [
        toolBlock({
          callID: "c-main",
          filePath: "src/foo.ts",
          patch: "@@\n+m",
          actor: { kind: "main" },
        }),
        toolBlock({
          callID: "c-sub",
          filePath: "src/foo.ts",
          patch: "@@\n+s",
          actor: { kind: "subagent", sessionID: "ses_child_1", subagent: "hephaestus" },
        }),
      ]),
    ]
    const { container } = render(<ReviewPanel messages={messages} reviewedHunks={{}} />)
    expect(container.querySelectorAll(".review-head")).toHaveLength(1)
    expect(container.querySelector(".review-file-actor")).toBeNull()
    const head = container.querySelector(".review-head") as HTMLElement
    expect(head.title).toContain("Modified by: hephaestus")
  })
})
