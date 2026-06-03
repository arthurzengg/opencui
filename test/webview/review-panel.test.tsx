import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ReviewPanel } from "../../webview/src/components/ReviewPanel"
import type { Message } from "../../webview/src/hooks/useChatState"

afterEach(cleanup)

function editMessage(id: string, opts: {
  filePath: string
  patch: string
  additions: number
  deletions: number
  callID?: string
}): Message {
  return {
    id,
    role: "assistant",
    blocks: [
      {
        type: "tool",
        update: {
          callID: opts.callID ?? `c-${id}`,
          tool: "edit",
          status: "completed",
          input: { filePath: opts.filePath },
          metadata: {
            filediff: { patch: opts.patch, additions: opts.additions, deletions: opts.deletions },
          },
        },
      },
    ],
  } as unknown as Message
}

function createMessage(id: string, opts: { filePath: string; content: string }): Message {
  return {
    id,
    role: "assistant",
    blocks: [
      {
        type: "tool",
        update: {
          callID: `c-${id}`,
          tool: "write",
          status: "completed",
          input: { filePath: opts.filePath, content: opts.content },
          metadata: { exists: false },
        },
      },
    ],
  } as unknown as Message
}

describe("ReviewPanel", () => {
  it("renders nothing when there are no pending changes", () => {
    const { container } = render(
      <ReviewPanel messages={[]} reviewedHunks={{}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("shows a single-row header for one pending change", () => {
    const messages = [
      editMessage("m1", {
        filePath: "src/foo.ts",
        patch: "@@ -1 +1 @@\n-old\n+new",
        additions: 1,
        deletions: 1,
      }),
    ]
    const { container } = render(<ReviewPanel messages={messages} reviewedHunks={{}} />)
    expect(screen.getByText("Review")).toBeInTheDocument()
    // The single-file card is one row: the filename shows once (no duplicate
    // body row), with inline Keep/Undo in the header.
    expect(screen.getByText("foo.ts")).toBeInTheDocument()
    expect(container.querySelector(".review-stat.add")?.textContent).toBe("+1")
    expect(container.querySelector(".review-stat.del")?.textContent).toBe("-1")
  })

  it("shows 'N files' summary for multi-file changes", () => {
    const messages = [
      editMessage("m1", { filePath: "a.ts", patch: "@@ -1 +1 @@\n+a", additions: 1, deletions: 0 }),
      editMessage("m2", { filePath: "b.ts", patch: "@@ -1 +1 @@\n+b", additions: 1, deletions: 0 }),
      editMessage("m3", { filePath: "c.ts", patch: "@@ -1 +1 @@\n+c", additions: 1, deletions: 0 }),
    ]
    render(<ReviewPanel messages={messages} reviewedHunks={{}} />)
    expect(screen.getByText(/Review changes/)).toBeInTheDocument()
    expect(screen.getByText(/3 files/)).toBeInTheDocument()
  })

  it("aggregates additions/deletions for the same path across multiple changes", () => {
    const messages = [
      editMessage("m1", { filePath: "foo.ts", patch: "@@\n+a\n+b\n+c", additions: 3, deletions: 0, callID: "edit-1" }),
      editMessage("m2", { filePath: "foo.ts", patch: "@@\n+d\n-e", additions: 1, deletions: 1, callID: "edit-2" }),
    ]
    const { container } = render(<ReviewPanel messages={messages} reviewedHunks={{}} />)
    // Single row (path collapsed) but stats aggregated across the two records
    expect(screen.getAllByRole("button", { name: /Keep changes in foo.ts/ })).toHaveLength(1)
    // Header shows combined stats
    expect(container.querySelector(".review-stat.add")?.textContent).toBe("+4")
    expect(container.querySelector(".review-stat.del")?.textContent).toBe("-1")
  })

  it("applies the kind-created class for a new file", () => {
    const messages = [createMessage("m1", { filePath: "new.ts", content: "line1\nline2\nline3" })]
    const { container } = render(<ReviewPanel messages={messages} reviewedHunks={{}} />)
    expect(container.querySelector(".kind-created")).not.toBeNull()
  })

  it("disambiguates same-basename paths in row labels", () => {
    const messages = [
      editMessage("m1", { filePath: "views/index.ts", patch: "@@\n+a", additions: 1, deletions: 0 }),
      editMessage("m2", { filePath: "admin/index.ts", patch: "@@\n+b", additions: 1, deletions: 0 }),
    ]
    render(<ReviewPanel messages={messages} reviewedHunks={{}} />)
    expect(screen.getByText("views/index.ts")).toBeInTheDocument()
    expect(screen.getByText("admin/index.ts")).toBeInTheDocument()
  })

  it("invokes onReviewAllInChange('accepted') when Keep is clicked", async () => {
    const user = userEvent.setup()
    const onReviewAllInChange = vi.fn()
    const messages = [
      editMessage("m1", { filePath: "foo.ts", patch: "@@\n+a", additions: 1, deletions: 0, callID: "call-x" }),
    ]
    render(
      <ReviewPanel
        messages={messages}
        reviewedHunks={{}}
        onReviewAllInChange={onReviewAllInChange}
      />,
    )
    const keep = screen.getByRole("button", { name: /Keep changes in foo.ts/ })
    await user.click(keep)
    expect(onReviewAllInChange).toHaveBeenCalledWith(expect.any(String), "foo.ts", "accepted")
  })

  it("invokes onReviewAllInChange('rejected') when Undo is clicked", async () => {
    const user = userEvent.setup()
    const onReviewAllInChange = vi.fn()
    const messages = [
      editMessage("m1", { filePath: "foo.ts", patch: "@@\n+a", additions: 1, deletions: 0 }),
    ]
    render(
      <ReviewPanel
        messages={messages}
        reviewedHunks={{}}
        onReviewAllInChange={onReviewAllInChange}
      />,
    )
    await user.click(screen.getByRole("button", { name: /Undo changes in foo.ts/ }))
    expect(onReviewAllInChange).toHaveBeenCalledWith(expect.any(String), "foo.ts", "rejected")
  })

  it("calls onSelectPath and onOpenReviewChange when the single-file header is clicked", async () => {
    const user = userEvent.setup()
    const onSelectPath = vi.fn()
    const onOpenReviewChange = vi.fn()
    const messages = [
      editMessage("m1", { filePath: "foo.ts", patch: "@@\n+a", additions: 1, deletions: 0 }),
    ]
    const { container } = render(
      <ReviewPanel
        messages={messages}
        reviewedHunks={{}}
        onSelectPath={onSelectPath}
        onOpenReviewChange={onOpenReviewChange}
      />,
    )
    const head = container.querySelector(".review-head") as HTMLElement
    await user.click(head)
    expect(onSelectPath).toHaveBeenCalledWith("foo.ts")
    expect(onOpenReviewChange).toHaveBeenCalled()
  })

  it("hides files where all hunks are reviewed", () => {
    const messages = [
      editMessage("m1", { filePath: "foo.ts", patch: "@@ -1,1 +1,1 @@\n-a\n+b", additions: 1, deletions: 1 }),
    ]
    // Simulate the hunk being already accepted via reviewKey: source:path:hunkID
    // splitDiff produces hunk id = "0-@@ -1,1 +1,1 @@"
    const reviewedHunks = { "c-m1:foo.ts:0-@@ -1,1 +1,1 @@": "accepted" as const }
    const { container } = render(
      <ReviewPanel messages={messages} reviewedHunks={reviewedHunks} />,
    )
    // No pending → panel returns null
    expect(container.firstChild).toBeNull()
  })

  it("toggles the panel via the header button (multi-file)", async () => {
    const user = userEvent.setup()
    const messages = [
      editMessage("m1", { filePath: "a.ts", patch: "@@\n+a", additions: 1, deletions: 0 }),
      editMessage("m2", { filePath: "b.ts", patch: "@@\n+b", additions: 1, deletions: 0 }),
    ]
    const { container } = render(<ReviewPanel messages={messages} reviewedHunks={{}} />)
    const header = container.querySelector(".review-head") as HTMLButtonElement
    expect(header.getAttribute("aria-expanded")).toBe("true")
    await user.click(header)
    expect(header.getAttribute("aria-expanded")).toBe("false")
  })

  it("renders 'Keep all' / 'Undo all' bulk buttons in the header when there are multiple files", () => {
    const messages = [
      editMessage("m1", { filePath: "a.ts", patch: "@@\n+a", additions: 1, deletions: 0 }),
      editMessage("m2", { filePath: "b.ts", patch: "@@\n+b", additions: 1, deletions: 0 }),
    ]
    render(<ReviewPanel messages={messages} reviewedHunks={{}} />)
    expect(screen.getByRole("button", { name: /Keep all/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Undo all/i })).toBeInTheDocument()
  })

  it("hides the bulk buttons when there is only a single file (the row button suffices)", () => {
    const messages = [
      editMessage("m1", { filePath: "only.ts", patch: "@@\n+a", additions: 1, deletions: 0 }),
    ]
    render(<ReviewPanel messages={messages} reviewedHunks={{}} />)
    expect(screen.queryByRole("button", { name: /Keep all/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /Undo all/i })).toBeNull()
  })

  it("Keep all calls onReviewAllInChange('accepted') once per pending file", async () => {
    const user = userEvent.setup()
    const onReviewAllInChange = vi.fn()
    const messages = [
      editMessage("m1", { filePath: "a.ts", patch: "@@\n+a", additions: 1, deletions: 0, callID: "c1" }),
      editMessage("m2", { filePath: "b.ts", patch: "@@\n+b", additions: 1, deletions: 0, callID: "c2" }),
    ]
    render(
      <ReviewPanel
        messages={messages}
        reviewedHunks={{}}
        onReviewAllInChange={onReviewAllInChange}
      />,
    )
    await user.click(screen.getByRole("button", { name: /Keep all/i }))
    expect(onReviewAllInChange).toHaveBeenCalledTimes(2)
    expect(onReviewAllInChange).toHaveBeenNthCalledWith(1, expect.any(String), "a.ts", "accepted")
    expect(onReviewAllInChange).toHaveBeenNthCalledWith(2, expect.any(String), "b.ts", "accepted")
  })

  it("Undo all calls onReviewAllInChange('rejected') once per pending file", async () => {
    const user = userEvent.setup()
    const onReviewAllInChange = vi.fn()
    const messages = [
      editMessage("m1", { filePath: "a.ts", patch: "@@\n+a", additions: 1, deletions: 0 }),
      editMessage("m2", { filePath: "b.ts", patch: "@@\n+b", additions: 1, deletions: 0 }),
    ]
    render(
      <ReviewPanel
        messages={messages}
        reviewedHunks={{}}
        onReviewAllInChange={onReviewAllInChange}
      />,
    )
    await user.click(screen.getByRole("button", { name: /Undo all/i }))
    expect(onReviewAllInChange).toHaveBeenCalledTimes(2)
    expect(onReviewAllInChange.mock.calls.every((c) => c[2] === "rejected")).toBe(true)
  })

  it("clicking the bulk buttons does NOT toggle the panel collapse", async () => {
    const user = userEvent.setup()
    const messages = [
      editMessage("m1", { filePath: "a.ts", patch: "@@\n+a", additions: 1, deletions: 0 }),
      editMessage("m2", { filePath: "b.ts", patch: "@@\n+b", additions: 1, deletions: 0 }),
    ]
    const { container } = render(
      <ReviewPanel messages={messages} reviewedHunks={{}} onReviewAllInChange={vi.fn()} />,
    )
    const header = container.querySelector(".review-head") as HTMLButtonElement
    expect(header.getAttribute("aria-expanded")).toBe("true")
    await user.click(screen.getByRole("button", { name: /Keep all/i }))
    expect(header.getAttribute("aria-expanded")).toBe("true") // not collapsed
  })

  it("retains 'created' kind when first change is create then later updated (turnChanges aggregation)", () => {
    const messages = [
      createMessage("m1", { filePath: "new.ts", content: "line1\nline2" }),
      editMessage("m2", { filePath: "new.ts", patch: "@@\n+x", additions: 1, deletions: 0 }),
    ]
    const { container } = render(<ReviewPanel messages={messages} reviewedHunks={{}} />)
    expect(container.querySelector(".kind-created")).not.toBeNull()
    expect(container.querySelector(".kind-updated")).toBeNull()
  })
})
