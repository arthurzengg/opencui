import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fireEvent, render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ModelPicker, buildPickerItems } from "../../webview/src/components/ModelPicker"
import { reducer, initialChatState } from "../../webview/src/hooks/useChatState"
import type { ModelCatalogInfo } from "../../webview/src/protocol"

beforeEach(() => {
  cleanup()
})
afterEach(cleanup)

const catalog: ModelCatalogInfo = {
  models: [
    {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
      providerName: "Anthropic",
      variants: ["max"],
      lastVariant: "max",
    },
    { providerID: "anthropic", modelID: "claude-haiku-4-5", providerName: "Anthropic", variants: [] },
    {
      providerID: "openai",
      modelID: "gpt-5.5",
      providerName: "OpenAI",
      variants: ["low", "medium", "high"],
    },
    { providerID: "google", modelID: "gemini-3-pro", providerName: "Google", variants: [] },
  ],
  recents: ["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"],
}

const baseProps = {
  catalog,
  selection: {},
  agentLabel: "default",
  onSetModel: vi.fn(),
  onSelectAgent: vi.fn(),
  onRefresh: vi.fn(),
  onClose: vi.fn(),
}

function rowNames(): string[] {
  return screen.getAllByRole("option").map((r) => r.querySelector(".model-picker-name")!.textContent!)
}

describe("buildPickerItems", () => {
  it("orders recents first (host order), then provider groups, then the default row", () => {
    const items = buildPickerItems(catalog, "")
    expect(items.map((i) => (i.kind === "model" ? `${i.section}:${i.entry.modelID}` : i.kind))).toEqual([
      "Recent:gpt-5.5",
      "Recent:claude-sonnet-4-6",
      "Anthropic:claude-sonnet-4-6",
      "Anthropic:claude-haiku-4-5",
      "OpenAI:gpt-5.5",
      "Google:gemini-3-pro",
      "default",
    ])
  })

  it("skips recents whose model is no longer in the catalog", () => {
    const items = buildPickerItems({ ...catalog, recents: ["openai/gone", "google/gemini-3-pro"] }, "")
    const recent = items.filter((i) => i.section === "Recent")
    expect(recent).toHaveLength(1)
  })

  it("filters with every whitespace token matched against provider/model/name", () => {
    const items = buildPickerItems(catalog, "anthropic sonnet")
    expect(items).toHaveLength(1)
    expect(items[0]!.kind === "model" && items[0]!.entry.modelID).toBe("claude-sonnet-4-6")
    // Filtered mode drops sections and the default row.
    expect(buildPickerItems(catalog, "gpt").some((i) => i.kind === "default")).toBe(false)
  })

  it("returns nothing while the catalog has not arrived", () => {
    expect(buildPickerItems(undefined, "")).toEqual([])
  })
})

describe("ModelPicker", () => {
  it("asks the host for a fresh catalog on mount", () => {
    const onRefresh = vi.fn()
    render(<ModelPicker {...baseProps} onRefresh={onRefresh} />)
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it("clicking a model row selects it WITH its remembered variant and closes", async () => {
    const user = userEvent.setup()
    const onSetModel = vi.fn()
    const onClose = vi.fn()
    render(<ModelPicker {...baseProps} onSetModel={onSetModel} onClose={onClose} />)
    // Second recent row: sonnet, whose lastVariant is "max".
    await user.click(screen.getAllByRole("option")[1]!)
    expect(onSetModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-6", "max")
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("clicking the default row resets to the opencode default model", async () => {
    const user = userEvent.setup()
    const onSetModel = vi.fn()
    render(<ModelPicker {...baseProps} onSetModel={onSetModel} />)
    await user.click(screen.getByRole("option", { name: /opencode default/ }))
    expect(onSetModel).toHaveBeenCalledWith(undefined, undefined, undefined)
  })

  it("marks the current model row with a check and starts keyboard focus on it", () => {
    render(
      <ModelPicker {...baseProps} selection={{ model: "openai/gpt-5.5" }} />,
    )
    const rows = screen.getAllByRole("option")
    // First recent row is gpt-5.5 — current, checked, and the active row.
    expect(rows[0]!.querySelector(".codicon-check")).toBeTruthy()
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true")
  })

  it("a chip click re-picks with that variant, stays open, and moves the active chip optimistically", async () => {
    const user = userEvent.setup()
    const onSetModel = vi.fn()
    const onClose = vi.fn()
    render(
      <ModelPicker
        {...baseProps}
        selection={{ model: "openai/gpt-5.5", modelVariant: "high" }}
        onSetModel={onSetModel}
        onClose={onClose}
      />,
    )
    const high = screen.getByRole("button", { name: "high" })
    expect(high.className).toContain("is-active")
    await user.click(screen.getByRole("button", { name: "medium" }))
    expect(onSetModel).toHaveBeenCalledWith("openai", "gpt-5.5", "medium")
    // Effort tuning is iterative — the popover must survive the click, and
    // the active chip must not wait for the host's selection echo.
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "medium" }).className).toContain("is-active")
    expect(high.className).not.toContain("is-active")
    // Focus returns to the search input so keyboard flow continues.
    expect(screen.getByRole("textbox", { name: "Search models" })).toHaveFocus()
  })

  it("the host's selection echo wins over the optimistic chip if they disagree", () => {
    const { rerender } = render(
      <ModelPicker {...baseProps} selection={{ model: "openai/gpt-5.5", modelVariant: "high" }} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "medium" }))
    expect(screen.getByRole("button", { name: "medium" }).className).toContain("is-active")
    rerender(
      <ModelPicker {...baseProps} selection={{ model: "openai/gpt-5.5", modelVariant: "low" }} />,
    )
    expect(screen.getByRole("button", { name: "low" }).className).toContain("is-active")
    expect(screen.getByRole("button", { name: "medium" }).className).not.toContain("is-active")
  })

  it("the default chip clears the variant for the current model without closing", async () => {
    const user = userEvent.setup()
    const onSetModel = vi.fn()
    const onClose = vi.fn()
    render(
      <ModelPicker
        {...baseProps}
        selection={{ model: "openai/gpt-5.5", modelVariant: "high" }}
        onSetModel={onSetModel}
        onClose={onClose}
      />,
    )
    await user.click(screen.getByRole("button", { name: "default" }))
    expect(onSetModel).toHaveBeenCalledWith("openai", "gpt-5.5", undefined)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "default" }).className).toContain("is-active")
  })

  it("renders the sliding thumb behind the chips (decorative, hidden from a11y)", () => {
    const { container } = render(
      <ModelPicker {...baseProps} selection={{ model: "openai/gpt-5.5" }} />,
    )
    const thumb = container.querySelector(".model-picker-chip-thumb")
    expect(thumb).not.toBeNull()
    expect(thumb!.getAttribute("aria-hidden")).toBe("true")
  })

  it("hides the effort chips when the current model has no variants", () => {
    render(<ModelPicker {...baseProps} selection={{ model: "google/gemini-3-pro" }} />)
    expect(screen.queryByText("Effort")).not.toBeInTheDocument()
  })

  it("typing filters the list; Enter picks the active match", () => {
    const onSetModel = vi.fn()
    render(<ModelPicker {...baseProps} onSetModel={onSetModel} />)
    const input = screen.getByRole("textbox", { name: "Search models" })
    fireEvent.change(input, { target: { value: "haiku" } })
    expect(rowNames()).toEqual(["claude-haiku-4-5"])
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSetModel).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5", undefined)
  })

  it("ArrowDown/ArrowUp move the active row and wrap; Enter selects it", () => {
    const onSetModel = vi.fn()
    render(<ModelPicker {...baseProps} onSetModel={onSetModel} />)
    const input = screen.getByRole("textbox", { name: "Search models" })
    fireEvent.keyDown(input, { key: "ArrowUp" }) // wraps from 0 to the last row (default)
    expect(screen.getByRole("option", { name: /opencode default/ }).getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSetModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-6", "max")
  })

  it("ignores Enter and arrows during IME composition", () => {
    const onSetModel = vi.fn()
    render(<ModelPicker {...baseProps} onSetModel={onSetModel} />)
    const input = screen.getByRole("textbox", { name: "Search models" })
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })
    fireEvent.keyDown(input, { key: "ArrowDown", keyCode: 229 })
    expect(onSetModel).not.toHaveBeenCalled()
    expect(screen.getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true")
  })

  it("a bare mouseenter is ignored after arrow-keying; real pointer movement re-enables hover", () => {
    render(<ModelPicker {...baseProps} />)
    const input = screen.getByRole("textbox", { name: "Search models" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    const rows = screen.getAllByRole("option")
    expect(rows[1]!.getAttribute("aria-selected")).toBe("true")
    // Scroll-synthesized mouseenter (no preceding pointer movement): ignored.
    fireEvent.mouseEnter(rows[3]!)
    expect(rows[1]!.getAttribute("aria-selected")).toBe("true")
    // Real movement: mousemove with changed coordinates, then enter.
    const list = screen.getByRole("listbox", { name: "Models" })
    fireEvent.mouseMove(list, { clientX: 10, clientY: 20 })
    fireEvent.mouseEnter(rows[3]!)
    expect(rows[3]!.getAttribute("aria-selected")).toBe("true")
  })

  it("shows a waiting state before the catalog arrives, still offering the agent row", () => {
    render(<ModelPicker {...baseProps} catalog={undefined} />)
    expect(screen.getByText(/Waiting for the model list/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Agent/ })).toBeInTheDocument()
  })

  it("agent footer row routes to onSelectAgent and closes", async () => {
    const user = userEvent.setup()
    const onSelectAgent = vi.fn()
    const onClose = vi.fn()
    render(<ModelPicker {...baseProps} onSelectAgent={onSelectAgent} onClose={onClose} />)
    await user.click(screen.getByRole("button", { name: /Agent/ }))
    expect(onSelectAgent).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe("modelCatalog reducer wiring", () => {
  it("stores the catalog and keeps it across reset/clear (workspace-scoped, like commands)", () => {
    const withCatalog = reducer(initialChatState, { type: "modelCatalog", catalog })
    expect(withCatalog.modelCatalog).toEqual(catalog)
    expect(reducer(withCatalog, { type: "reset" }).modelCatalog).toEqual(catalog)
    expect(reducer(withCatalog, { type: "clear" }).modelCatalog).toEqual(catalog)
  })
})
