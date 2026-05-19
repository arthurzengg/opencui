import { describe, it, expect, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { ContextManifest } from "../../webview/src/components/ContextManifest"
import type { PromptContextManifest } from "../../webview/src/protocol"

afterEach(cleanup)

function manifest(overrides: Partial<PromptContextManifest> = {}): PromptContextManifest {
  return {
    version: 1,
    workspace: {
      name: "repo",
      root: "/repo",
      isDefault: true,
      multiRoot: false,
      configMode: "isolated",
    },
    opencode: { directory: "/repo", configMode: "isolated" },
    totals: { includedItems: 0, skippedItems: 0, truncatedItems: 0, includedBytes: 0, budgetBytes: 0 },
    items: [],
    ...overrides,
  }
}

describe("ContextManifest", () => {
  it("renders nothing when no workspace and no items", () => {
    const { container } = render(
      <ContextManifest context={manifest({ workspace: undefined, items: [] })} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the workspace pill when only the workspace is present", () => {
    render(<ContextManifest context={manifest()} />)
    expect(screen.getByText("Context")).toBeInTheDocument()
    expect(screen.getByText(/repo/)).toBeInTheDocument()
  })

  it("shows the included count and bytes in the pill", () => {
    render(
      <ContextManifest
        context={manifest({
          items: [
            { id: "1", source: "mention", kind: "file", label: "a.ts", reason: "", status: "included", bytes: 100 },
            { id: "2", source: "mention", kind: "file", label: "b.ts", reason: "", status: "included", bytes: 200 },
          ],
          totals: { includedItems: 2, skippedItems: 0, truncatedItems: 0, includedBytes: 300, budgetBytes: 0 },
        })}
      />,
    )
    expect(screen.getByText(/2 items/)).toBeInTheDocument()
    expect(screen.getByText(/300 B/)).toBeInTheDocument()
  })

  it("reports truncated and skipped counts in the pill summary", () => {
    render(
      <ContextManifest
        context={manifest({
          items: [
            { id: "1", source: "mention", kind: "file", label: "big.ts", reason: "", status: "truncated", bytes: 200 },
            { id: "2", source: "mention", kind: "file", label: "miss.ts", reason: "", status: "skipped" },
          ],
          totals: { includedItems: 1, skippedItems: 1, truncatedItems: 1, includedBytes: 200, budgetBytes: 0 },
        })}
      />,
    )
    expect(screen.getByText(/1 truncated/)).toBeInTheDocument()
    expect(screen.getByText(/1 skipped/)).toBeInTheDocument()
  })

  it("expands and collapses on header click", () => {
    render(
      <ContextManifest
        context={manifest({
          items: [
            { id: "1", source: "mention", kind: "file", label: "a.ts", reason: "Mentioned", status: "included" },
          ],
        })}
      />,
    )
    // Collapsed → item not visible (only one occurrence in the summary path).
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("Context").closest("button")!)
    expect(screen.getByText("a.ts")).toBeInTheDocument()
    expect(screen.getByText("Mentions")).toBeInTheDocument()
  })

  it("renders an `external` badge for external items", () => {
    render(
      <ContextManifest
        context={manifest({
          items: [
            {
              id: "1",
              source: "external",
              kind: "file",
              label: "/elsewhere/file.md",
              reason: "Outside workspace",
              status: "included",
              external: true,
            },
          ],
        })}
      />,
    )
    fireEvent.click(screen.getByText("Context").closest("button")!)
    expect(screen.getByText("external")).toBeInTheDocument()
  })
})
