import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fireEvent, render, screen, cleanup, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ModelPicker, buildPickerItems, buildPickerSections } from "../../webview/src/components/ModelPicker"
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
  agents: [{ name: "build", description: "makes changes" }, { name: "plan" }],
}

const baseProps = {
  catalog,
  selection: {},
  onSetModel: vi.fn(),
  onSetAgent: vi.fn(),
  onSetProviderCollapsed: vi.fn(),
  onRefresh: vi.fn(),
  onClose: vi.fn(),
}

const noFolds: ReadonlySet<string> = new Set()

function effortChips() {
  return within(screen.getByRole("group", { name: "Effort" }))
}
function agentChips() {
  return within(screen.getByRole("group", { name: "Agent" }))
}

function rowNames(): string[] {
  return screen.getAllByRole("option").map((r) => r.querySelector(".model-picker-name")!.textContent!)
}

describe("buildPickerItems", () => {
  it("orders recents first (host order), then provider groups, then the default row", () => {
    const items = buildPickerItems(catalog, "", noFolds)
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
    const items = buildPickerItems({ ...catalog, recents: ["openai/gone", "google/gemini-3-pro"] }, "", noFolds)
    const recent = items.filter((i) => i.section === "Recent")
    expect(recent).toHaveLength(1)
  })

  it("filters with every whitespace token matched against provider/model/name", () => {
    const items = buildPickerItems(catalog, "anthropic sonnet", noFolds)
    expect(items).toHaveLength(1)
    expect(items[0]!.kind === "model" && items[0]!.entry.modelID).toBe("claude-sonnet-4-6")
    // Filtered mode drops Recent and the default row.
    expect(buildPickerItems(catalog, "gpt", noFolds).some((i) => i.kind === "default")).toBe(false)
  })

  it("keeps matches grouped by provider while filtering", () => {
    const sections = buildPickerSections(catalog, "g", noFolds)
    expect(
      sections.map((s) => ({
        title: s.title,
        rows: s.rows.map((r) => (r.kind === "model" ? `${r.section}:${r.entry.modelID}` : r.kind)),
      })),
    ).toEqual([
      { title: "OpenAI", rows: ["OpenAI:gpt-5.5"] },
      { title: "Google", rows: ["Google:gemini-3-pro"] },
    ])
  })

  it("returns nothing while the catalog has not arrived", () => {
    expect(buildPickerItems(undefined, "", noFolds)).toEqual([])
  })

  it("a folded provider's rows leave the flat list; Recent and Default stay", () => {
    const items = buildPickerItems(catalog, "", new Set(["anthropic"]))
    expect(items.map((i) => (i.kind === "model" ? `${i.section}:${i.entry.modelID}` : i.kind))).toEqual([
      "Recent:gpt-5.5",
      "Recent:claude-sonnet-4-6",
      "OpenAI:gpt-5.5",
      "Google:gemini-3-pro",
      "default",
    ])
  })

  it("a folded provider keeps its section so the header stays clickable", () => {
    const sections = buildPickerSections(catalog, "", new Set(["anthropic"]))
    const anthropic = sections.find((s) => s.providerID === "anthropic")!
    expect(anthropic.collapsed).toBe(true)
    expect(anthropic.rows).toHaveLength(2)
    expect(sections.filter((s) => s.collapsed)).toHaveLength(1)
  })

  it("sections fold by whatever set the caller passes; the search view hands over its transient folds (#565)", () => {
    // The rows leave the keyboard list, but the section survives with its
    // matches — the header is what proves the folded provider has any.
    const items = buildPickerItems(catalog, "haiku", new Set(["anthropic"]))
    expect(items).toEqual([])
    const sections = buildPickerSections(catalog, "haiku", new Set(["anthropic"]))
    expect(sections).toHaveLength(1)
    expect(sections[0]!.collapsed).toBe(true)
    expect(sections[0]!.title).toBe("Anthropic")
    expect(sections[0]!.rows).toHaveLength(1)
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
    await user.click(effortChips().getByRole("button", { name: "default" }))
    expect(onSetModel).toHaveBeenCalledWith("openai", "gpt-5.5", undefined)
    expect(onClose).not.toHaveBeenCalled()
    expect(effortChips().getByRole("button", { name: "default" }).className).toContain("is-active")
  })

  it("renders a sliding thumb per chip group (decorative, hidden from a11y)", () => {
    const { container } = render(
      <ModelPicker {...baseProps} selection={{ model: "openai/gpt-5.5" }} />,
    )
    const thumbs = container.querySelectorAll(".model-picker-chip-thumb")
    // One in the Effort group, one in the Agent group.
    expect(thumbs).toHaveLength(2)
    for (const thumb of thumbs) expect(thumb.getAttribute("aria-hidden")).toBe("true")
  })

  it("hides the effort chips when the current model has no variants", () => {
    render(<ModelPicker {...baseProps} selection={{ model: "google/gemini-3-pro" }} />)
    expect(screen.queryByText("Effort")).not.toBeInTheDocument()
  })

  it("renders the chip rows as a footer: list first, then Effort, then Agent", () => {
    render(<ModelPicker {...baseProps} selection={{ model: "openai/gpt-5.5" }} />)
    const list = screen.getByRole("listbox", { name: "Models" })
    const effort = screen.getByRole("group", { name: "Effort" })
    const agent = screen.getByRole("group", { name: "Agent" })
    expect(list.compareDocumentPosition(effort) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(effort.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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

  it("shows a waiting state before the catalog arrives (agent chips wait with it)", () => {
    render(<ModelPicker {...baseProps} catalog={undefined} />)
    expect(screen.getByText(/Waiting for the model list/)).toBeInTheDocument()
    expect(screen.queryByRole("group", { name: "Agent" })).not.toBeInTheDocument()
  })

  it("an agent chip picks that agent, stays open, and moves the active chip optimistically", async () => {
    const user = userEvent.setup()
    const onSetAgent = vi.fn()
    const onClose = vi.fn()
    render(
      <ModelPicker {...baseProps} selection={{ agent: "build" }} onSetAgent={onSetAgent} onClose={onClose} />,
    )
    const build = agentChips().getByRole("button", { name: "build" })
    expect(build.className).toContain("is-active")
    await user.click(agentChips().getByRole("button", { name: "plan" }))
    expect(onSetAgent).toHaveBeenCalledWith("plan")
    // Same stay-open contract as the effort chips — the popover survives the
    // click and the active chip moves before the host's selection echo.
    expect(onClose).not.toHaveBeenCalled()
    expect(agentChips().getByRole("button", { name: "plan" }).className).toContain("is-active")
    expect(build.className).not.toContain("is-active")
    expect(screen.getByRole("textbox", { name: "Search models" })).toHaveFocus()
  })

  it("the default agent chip resets to the opencode default without closing", async () => {
    const user = userEvent.setup()
    const onSetAgent = vi.fn()
    const onClose = vi.fn()
    render(
      <ModelPicker {...baseProps} selection={{ agent: "build" }} onSetAgent={onSetAgent} onClose={onClose} />,
    )
    await user.click(agentChips().getByRole("button", { name: "default" }))
    expect(onSetAgent).toHaveBeenCalledWith(undefined)
    expect(onClose).not.toHaveBeenCalled()
    expect(agentChips().getByRole("button", { name: "default" }).className).toContain("is-active")
  })

  it("the host's selection echo wins over the optimistic agent chip if they disagree", () => {
    const { rerender } = render(<ModelPicker {...baseProps} selection={{ agent: "build" }} />)
    fireEvent.click(agentChips().getByRole("button", { name: "plan" }))
    expect(agentChips().getByRole("button", { name: "plan" }).className).toContain("is-active")
    rerender(<ModelPicker {...baseProps} selection={{ agent: "build" }} />)
    // Same agent echoed back — the optimistic pick stands until told otherwise.
    expect(agentChips().getByRole("button", { name: "plan" }).className).toContain("is-active")
    rerender(<ModelPicker {...baseProps} selection={{}} />)
    expect(agentChips().getByRole("button", { name: "default" }).className).toContain("is-active")
    expect(agentChips().getByRole("button", { name: "plan" }).className).not.toContain("is-active")
  })

  it("hides the agent chips when the catalog reports no agents", () => {
    render(<ModelPicker {...baseProps} catalog={{ ...catalog, agents: [] }} />)
    expect(screen.queryByRole("group", { name: "Agent" })).not.toBeInTheDocument()
  })
})

describe("ModelPicker provider folding", () => {
  it("clicking a provider header folds its rows and reports the fold to the host", async () => {
    const user = userEvent.setup()
    const onSetProviderCollapsed = vi.fn()
    render(<ModelPicker {...baseProps} onSetProviderCollapsed={onSetProviderCollapsed} />)
    const header = screen.getByRole("button", { name: "Anthropic" })
    expect(header.getAttribute("aria-expanded")).toBe("true")
    await user.click(header)
    expect(onSetProviderCollapsed).toHaveBeenCalledWith("anthropic", true)
    expect(header.getAttribute("aria-expanded")).toBe("false")
    // Provider rows gone; the Recent copy of sonnet stays.
    expect(rowNames()).toEqual(["gpt-5.5", "claude-sonnet-4-6", "gpt-5.5", "gemini-3-pro", "opencode default"])
    // Focus handed back to the search line so arrows keep working (chip pattern).
    expect(screen.getByRole("textbox", { name: "Search models" })).toHaveFocus()
    await user.click(header)
    expect(onSetProviderCollapsed).toHaveBeenLastCalledWith("anthropic", false)
    expect(rowNames()).toContain("claude-haiku-4-5")
  })

  it("a catalog arriving with folded providers renders them folded", () => {
    render(<ModelPicker {...baseProps} catalog={{ ...catalog, collapsedProviders: ["google"] }} />)
    expect(rowNames()).not.toContain("gemini-3-pro")
    expect(screen.getByRole("button", { name: "Google" }).getAttribute("aria-expanded")).toBe("false")
  })

  it("a provider folded in the browse view starts revealed while searching (#565)", () => {
    const onSetProviderCollapsed = vi.fn()
    render(
      <ModelPicker
        {...baseProps}
        onSetProviderCollapsed={onSetProviderCollapsed}
        catalog={{ ...catalog, collapsedProviders: ["anthropic"] }}
      />,
    )
    const input = screen.getByRole("textbox", { name: "Search models" })
    fireEvent.change(input, { target: { value: "haiku" } })
    // The user typed a name to SEE it — the browse fold must not hide it.
    expect(rowNames()).toEqual(["claude-haiku-4-5"])
    expect(screen.getByRole("button", { name: "Anthropic" }).getAttribute("aria-expanded")).toBe("true")
    // Clearing the query returns to the browse view with its fold intact.
    fireEvent.change(input, { target: { value: "" } })
    expect(screen.getByRole("button", { name: "Anthropic" }).getAttribute("aria-expanded")).toBe("false")
    expect(onSetProviderCollapsed).not.toHaveBeenCalled()
  })

  it("folding mid-search is transient: local to the session, never persisted (#565)", () => {
    const onSetProviderCollapsed = vi.fn()
    render(<ModelPicker {...baseProps} onSetProviderCollapsed={onSetProviderCollapsed} />)
    const input = screen.getByRole("textbox", { name: "Search models" })
    fireEvent.change(input, { target: { value: "g" } })
    expect(rowNames()).toEqual(["gpt-5.5", "gemini-3-pro"])
    const google = screen.getByRole("button", { name: "Google" })
    expect(google.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(google)
    expect(rowNames()).toEqual(["gpt-5.5"])
    expect(onSetProviderCollapsed).not.toHaveBeenCalled()
    // The fold survives refining the query within the same session; hidden
    // matches are still matches, so no empty state over the folded header.
    fireEvent.change(input, { target: { value: "gem" } })
    expect(screen.queryAllByRole("option")).toHaveLength(0)
    expect(screen.queryByText(/No models match/)).toBeNull()
    // A query with no matches at all still gets the empty state.
    fireEvent.change(input, { target: { value: "zzz" } })
    expect(screen.getByText(/No models match/)).toBeInTheDocument()
    // Leaving search discards the session fold: the browse view is untouched
    // and the next search starts fully revealed again.
    fireEvent.change(input, { target: { value: "" } })
    expect(screen.getByRole("button", { name: "Google" }).getAttribute("aria-expanded")).toBe("true")
    fireEvent.change(input, { target: { value: "g" } })
    expect(rowNames()).toEqual(["gpt-5.5", "gemini-3-pro"])
    expect(onSetProviderCollapsed).not.toHaveBeenCalled()
  })

  it("folding the tail group clamps the active index instead of stranding it", async () => {
    const user = userEvent.setup()
    const onSetModel = vi.fn()
    render(<ModelPicker {...baseProps} onSetModel={onSetModel} />)
    const input = screen.getByRole("textbox", { name: "Search models" })
    fireEvent.keyDown(input, { key: "ArrowUp" }) // wrap to the last row (default)
    await user.click(screen.getByRole("button", { name: "Google" }))
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSetModel).toHaveBeenCalledWith(undefined, undefined, undefined)
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
