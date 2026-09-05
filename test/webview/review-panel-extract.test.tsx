import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { ReviewPanel } from "../../webview/src/components/ReviewPanel"
import type { Message } from "../../webview/src/hooks/useChatState"

// Counts how often the panel re-extracts changes from the transcript. A
// streamed delta hands the panel a new messages array on every frame, and
// extraction walks every block of every message, so it must run only when
// the reducer says the review set may have changed (#603).
const extracts = vi.hoisted(() => ({ count: 0 }))
vi.mock("../../webview/src/review-extract", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../webview/src/review-extract")>()
  return {
    ...mod,
    turnChanges: (messages: Message[]) => {
      extracts.count++
      return mod.turnChanges(messages)
    },
  }
})

afterEach(() => {
  cleanup()
  extracts.count = 0
})

function editMessage(id: string, filePath: string): Message {
  return {
    id,
    role: "assistant",
    blocks: [
      {
        type: "tool",
        update: {
          callID: `c-${id}`,
          tool: "edit",
          status: "completed",
          input: { filePath },
          metadata: { filediff: { patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1 } },
        },
      },
    ],
  } as unknown as Message
}

function withText(message: Message, text: string): Message {
  return { ...message, blocks: [...message.blocks, { type: "text", text }] }
}

describe("ReviewPanel extraction keys on reviewRevision", () => {
  it("does not re-extract for a new messages array at the same revision, and does when it bumps", () => {
    const first = editMessage("a1", "src/foo.ts")
    const { rerender, container } = render(
      <ReviewPanel messages={[first]} reviewRevision={1} reviewedHunks={{}} />,
    )
    expect(extracts.count).toBe(1)
    expect(container.textContent).toContain("foo.ts")

    // Four streamed frames: each replaces the array and grows the text block.
    let streamed = first
    for (let i = 0; i < 4; i++) {
      streamed = withText(streamed, `token ${i}`)
      rerender(<ReviewPanel messages={[streamed]} reviewRevision={1} reviewedHunks={{}} />)
    }
    expect(extracts.count).toBe(1)
    expect(container.textContent).toContain("foo.ts")

    rerender(
      <ReviewPanel messages={[streamed, editMessage("a2", "src/bar.ts")]} reviewRevision={2} reviewedHunks={{}} />,
    )
    expect(extracts.count).toBe(2)
    expect(container.textContent).toContain("foo.ts")
    expect(container.textContent).toContain("bar.ts")
  })

  it("a hunk state change recomputes pending rows without re-extracting", () => {
    const first = editMessage("a1", "src/foo.ts")
    const { rerender, container } = render(
      <ReviewPanel messages={[first]} reviewRevision={1} reviewedHunks={{}} />,
    )
    expect(container.firstChild).not.toBeNull()
    // reviewKey is source:path:hunkID, and splitDiff ids a hunk by its
    // index and header.
    rerender(
      <ReviewPanel
        messages={[first]}
        reviewRevision={1}
        reviewedHunks={{ "c-a1:src/foo.ts:0-@@ -1 +1 @@": "accepted" }}
      />,
    )
    expect(container.firstChild).toBeNull()
    expect(extracts.count).toBe(1)
  })
})
