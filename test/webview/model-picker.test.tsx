import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fireEvent, render, screen, cleanup, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  ModelPicker,
  buildAgentSection,
  buildPickerItems,
  buildPickerSections,
  type PickerItem,
} from "../../webview/src/components/ModelPicker"
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
}

const noFolds: ReadonlySet<string> = new Set()

function effortChips() {
  return within(screen.getByRole("group", { name: "Effort" }))
}

function rowNames(): string[] {
  return screen.getAllByRole("option").map((r) => r.querySelector(".model-picker-name")!.textContent!)
}
/** First row whose name matches; agent names never collide with model ids here. */
function rowNamed(name: string): HTMLElement {
  return screen.getAllByRole("option").find((r) => r.querySelector(".model-picker-name")?.textContent === name)!
}
function itemLabel(i: PickerItem): string {
  if (i.kind === "model") return `${i.section}:${i.entry.modelID}`
  if (i.kind === "agent") return `${i.section}:${i.entry.name}`
  return i.kind
}

describe("buildPickerItems", () => {
  it("orders recents first (host order), then provider groups, the default row, then the agents", () => {
    const items = buildPickerItems(catalog, "", noFolds)
    expect(items.map(itemLabel)).toEqual([
      "Recent:gpt-5.5",
      "Recent:claude-sonnet-4-6",
      "Anthropic:claude-sonnet-4-6",
      "Anthropic:claude-haiku-4-5",
      "OpenAI:gpt-5.5",
      "Google:gemini-3-pro",
      "default",
      "agentDefault",
      "Agent:build",
      "Agent:plan",
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

  it("a folded provider's rows leave the flat list; Recent, Default, and Agent stay", () => {
    const items = buildPickerItems(catalog, "", new Set(["anthropic"]))
    expect(items.map(itemLabel)).toEqual([
      "Recent:gpt-5.5",
      "Recent:claude-sonnet-4-6",
      "OpenAI:gpt-5.5",
      "Google:gemini-3-pro",
      "default",
      "agentDefault",
      "Agent:build",
      "Agent:plan",
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

describe("buildAgentSection", () => {
  it("leads with the default row, then the agents in catalog order", () => {
    const section = buildAgentSection(catalog, "")!
    expect(section.title).toBe("Agent")
    expect(section.collapsed).toBe(false)
    expect(section.rows.map(itemLabel)).toEqual(["agentDefault", "Agent:build", "Agent:plan"])
  })

  it("filters by name only, dropping the default row while searching", () => {
    expect(buildAgentSection(catalog, "plan")!.rows.map(itemLabel)).toEqual(["Agent:plan"])
    // "changes" is in build's description, which is prose, not identity.
    expect(buildAgentSection(catalog, "changes")).toBeUndefined()
    expect(buildAgentSection(catalog, "b")!.rows.map(itemLabel)).toEqual(["Agent:build"])
  })

  it("is absent without a catalog or without agents", () => {
    expect(buildAgentSection(undefined, "")).toBeUndefined()
    expect(buildAgentSection({ ...catalog, agents: [] }, "")).toBeUndefined()
  })
})

describe("ModelPicker", () => {
  it("asks the host for a fresh catalog on mount", () => {
    const onRefresh = vi.fn()
    render(<ModelPicker {...baseProps} onRefresh={onRefresh} />)
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it("clicking a model row selects it WITH its remembered variant and marks it current before the host echo", async () => {
    const user = userEvent.setup()
    const onSetModel = vi.fn()
    render(<ModelPicker {...baseProps} selection={{ model: "openai/gpt-5.5" }} onSetModel={onSetModel} />)
    // Second recent row: sonnet, whose lastVariant is "max".
    const rows = screen.getAllByRole("option")
    await user.click(rows[1]!)
    expect(onSetModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-6", "max")
    expect(rows[1]!.querySelector(".codicon-check")).toBeTruthy()
    expect(rows[0]!.querySelector(".codicon-check")).toBeNull()
    expect(rows[1]!.getAttribute("aria-selected")).toBe("true")
    // The effort chips switch to the picked model with its remembered variant.
    expect(effortChips().getByRole("button", { name: "max" }).className).toContain("is-active")
    // Focus returns to the search input so keyboard flow continues.
    expect(screen.getByRole("textbox", { name: "Search models and agents" })).toHaveFocus()
  })

  it("the host's selection echo wins over the optimistic model pick if they disagree", () => {
    const { rerender } = render(<ModelPicker {...baseProps} selection={{ model: "openai/gpt-5.5" }} />)
    fireEvent.click(screen.getAllByRole("option")[1]!)
    expect(screen.getAllByRole("option")[1]!.querySelector(".codicon-check")).toBeTruthy()
    rerender(<ModelPicker {...baseProps} selection={{ model: "google/gemini-3-pro" }} />)
    const rows = screen.getAllByRole("option")
    expect(rows[1]!.querySelector(".codicon-check")).toBeNull()
    const gemini = rows.find((r) => r.querySelector(".model-picker-name")?.textContent === "gemini-3-pro")!
    expect(gemini.querySelector(".codicon-check")).toBeTruthy()
  })

  it("keeps the Recent order seen at open when the catalog echo moves the pick to the top", () => {
    const { rerender } = render(<ModelPicker {...baseProps} selection={{ model: "openai/gpt-5.5" }} />)
    fireEvent.click(screen.getAllByRole("option")[1]!)
    // The host answers a pick with the selection and a catalog whose Recent
    // now leads with the picked model.
    const echoed = { ...catalog, recents: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5"] }
    rerender(
      <ModelPicker
        {...baseProps}
        catalog={echoed}
        selection={{ model: "anthropic/claude-sonnet-4-6", modelVariant: "max" }}
      />,
    )
    expect(rowNames().slice(0, 2)).toEqual(["gpt-5.5", "claude-sonnet-4-6"])
    expect(screen.getAllByRole("option")[1]!.querySelector(".codicon-check")).toBeTruthy()
    // A fresh open reads the new order.
    cleanup()
    render(<ModelPicker {...baseProps} catalog={echoed} selection={{ model: "anthropic/claude-sonnet-4-6" }} />)
    expect(rowNames().slice(0, 2)).toEqual(["claude-sonnet-4-6", "gpt-5.5"])
  })

  it("keeps the highlight on the provider row the user clicked when the catalog echo arrives", () => {
    const { rerender } = render(<ModelPicker {...baseProps} selection={{ model: "openai/gpt-5.5" }} />)
    // gpt-5.5 has two rows: the Recent copy and the OpenAI group copy.
    const providerRow = () =>
      screen.getAllByRole("option").filter((r) => r.querySelector(".model-picker-name")?.textContent === "gpt-5.5")[1]!
    fireEvent.click(providerRow())
    expect(providerRow().getAttribute("aria-selected")).toBe("true")
    rerender(<ModelPicker {...baseProps} catalog={{ ...catalog }} selection={{ model: "openai/gpt-5.5" }} />)
    expect(providerRow().getAttribute("aria-selected")).toBe("true")
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
    // The check sits in a leading slot that every row renders, so names stay
    // aligned whichever row is current.
    for (const row of rows) expect(row.firstElementChild!.className).toBe("model-picker-check")
    expect(rows[0]!.firstElementChild!.querySelector(".codicon-check")).toBeTruthy()
    expect(rows[1]!.firstElementChild!.querySelector(".codicon-check")).toBeNull()
  })

  it("a chip click re-picks with that variant and moves the active chip optimistically", async () => {
    const user = userEvent.setup()
    const onSetModel = vi.fn()
    render(
      <ModelPicker
        {...baseProps}
        selection={{ model: "openai/gpt-5.5", modelVariant: "high" }}
        onSetModel={onSetModel}
      />,
    )
    const high = screen.getByRole("button", { name: "high" })
    expect(high.className).toContain("is-active")
    await user.click(screen.getByRole("button", { name: "medium" }))
    expect(onSetModel).toHaveBeenCalledWith("openai", "gpt-5.5", "medium")
    // The active chip must not wait for the host's selection echo.
    expect(screen.getByRole("button", { name: "medium" }).className).toContain("is-active")
    expect(high.className).not.toContain("is-active")
    // Focus returns to the search input so keyboard flow continues.
    expect(screen.getByRole("textbox", { name: "Search models and agents" })).toHaveFocus()
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

  it("the default chip clears the variant for the current model", async () => {
    const user = userEvent.setup()
    const onSetModel = vi.fn()
    render(
      <ModelPicker
        {...baseProps}
        selection={{ model: "openai/gpt-5.5", modelVariant: "high" }}
        onSetModel={onSetModel}
      />,
    )
    await user.click(effortChips().getByRole("button", { name: "default" }))
    expect(onSetModel).toHaveBeenCalledWith("openai", "gpt-5.5", undefined)
    expect(effortChips().getByRole("button", { name: "default" }).className).toContain("is-active")
  })

  it("renders a sliding thumb in the Effort group (decorative, hidden from a11y)", () => {
    const { container } = render(
      <ModelPicker {...baseProps} selection={{ model: "openai/gpt-5.5" }} />,
    )
    const thumbs = container.querySelectorAll(".model-picker-chip-thumb")
    expect(thumbs).toHaveLength(1)
    expect(thumbs[0]!.getAttribute("aria-hidden")).toBe("true")
  })

  it("hides the effort chips when the current model has no variants", () => {
    render(<ModelPicker {...baseProps} selection={{ model: "google/gemini-3-pro" }} />)
    expect(screen.queryByText("Effort")).not.toBeInTheDocument()
  })

  it("lists agents as the last section, inside the list and above the Effort footer", () => {
    render(<ModelPicker {...baseProps} selection={{ model: "openai/gpt-5.5" }} />)
    const list = screen.getByRole("listbox", { name: "Models and agents" })
    const header = screen.getByText("Agent")
    const effort = screen.getByRole("group", { name: "Effort" })
    expect(list.contains(header)).toBe(true)
    expect(header.className).toBe("model-picker-section")
    expect(screen.getByText("Default").compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(list.compareDocumentPosition(effort) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(rowNames().slice(-3)).toEqual(["default", "build", "plan"])
  })

  it("typing filters the list; Enter picks the active match", () => {
    const onSetModel = vi.fn()
    render(<ModelPicker {...baseProps} onSetModel={onSetModel} />)
    const input = screen.getByRole("textbox", { name: "Search models and agents" })
    fireEvent.change(input, { target: { value: "haiku" } })
    expect(rowNames()).toEqual(["claude-haiku-4-5"])
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSetModel).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5", undefined)
  })

  it("ArrowDown/ArrowUp move the active row and wrap; Enter selects it", () => {
    const onSetModel = vi.fn()
    render(<ModelPicker {...baseProps} onSetModel={onSetModel} />)
    const input = screen.getByRole("textbox", { name: "Search models and agents" })
    fireEvent.keyDown(input, { key: "ArrowUp" }) // wraps from 0 to the last row (the last agent)
    expect(rowNamed("plan").getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSetModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-6", "max")
  })

  it("ignores Enter and arrows during IME composition", () => {
    const onSetModel = vi.fn()
    render(<ModelPicker {...baseProps} onSetModel={onSetModel} />)
    const input = screen.getByRole("textbox", { name: "Search models and agents" })
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })
    fireEvent.keyDown(input, { key: "ArrowDown", keyCode: 229 })
    expect(onSetModel).not.toHaveBeenCalled()
    expect(screen.getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true")
  })

  it("a bare mouseenter is ignored after arrow-keying; real pointer movement re-enables hover", () => {
    render(<ModelPicker {...baseProps} />)
    const input = screen.getByRole("textbox", { name: "Search models and agents" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    const rows = screen.getAllByRole("option")
    expect(rows[1]!.getAttribute("aria-selected")).toBe("true")
    // Scroll-synthesized mouseenter (no preceding pointer movement): ignored.
    fireEvent.mouseEnter(rows[3]!)
    expect(rows[1]!.getAttribute("aria-selected")).toBe("true")
    // Real movement: mousemove with changed coordinates, then enter.
    const list = screen.getByRole("listbox", { name: "Models and agents" })
    fireEvent.mouseMove(list, { clientX: 10, clientY: 20 })
    fireEvent.mouseEnter(rows[3]!)
    expect(rows[3]!.getAttribute("aria-selected")).toBe("true")
  })

  it("shows a waiting state before the catalog arrives (agent rows wait with it)", () => {
    render(<ModelPicker {...baseProps} catalog={undefined} />)
    expect(screen.getByText(/Waiting for the model list/)).toBeInTheDocument()
    expect(screen.queryByText("Agent")).toBeNull()
  })

  it("clicking an agent row picks that agent and moves the check before the host echo", async () => {
    const user = userEvent.setup()
    const onSetAgent = vi.fn()
    const onSetModel = vi.fn()
    render(
      <ModelPicker {...baseProps} selection={{ agent: "build" }} onSetAgent={onSetAgent} onSetModel={onSetModel} />,
    )
    expect(rowNamed("build").querySelector(".codicon-check")).toBeTruthy()
    expect(rowNamed("build").className).toContain("is-current")
    await user.click(rowNamed("plan"))
    expect(onSetAgent).toHaveBeenCalledWith("plan")
    expect(onSetModel).not.toHaveBeenCalled()
    // Same contract as a model row: the check and the highlight move before
    // the host's selection echo.
    expect(rowNamed("plan").querySelector(".codicon-check")).toBeTruthy()
    expect(rowNamed("plan").getAttribute("aria-selected")).toBe("true")
    expect(rowNamed("build").querySelector(".codicon-check")).toBeNull()
    expect(screen.getByRole("textbox", { name: "Search models and agents" })).toHaveFocus()
  })

  it("the default agent row resets to the opencode default", async () => {
    const user = userEvent.setup()
    const onSetAgent = vi.fn()
    render(<ModelPicker {...baseProps} selection={{ agent: "build" }} onSetAgent={onSetAgent} />)
    const row = rowNamed("default")
    expect(row.getAttribute("title")).toBe("Use the opencode default agent")
    await user.click(row)
    expect(onSetAgent).toHaveBeenCalledWith(undefined)
    expect(rowNamed("default").querySelector(".codicon-check")).toBeTruthy()
    expect(rowNamed("build").querySelector(".codicon-check")).toBeNull()
  })

  it("the host's selection echo wins over the optimistic agent pick if they disagree", () => {
    const { rerender } = render(<ModelPicker {...baseProps} selection={{ agent: "build" }} />)
    fireEvent.click(rowNamed("plan"))
    expect(rowNamed("plan").querySelector(".codicon-check")).toBeTruthy()
    rerender(<ModelPicker {...baseProps} selection={{ agent: "build" }} />)
    // Same agent echoed back — the optimistic pick stands until told otherwise.
    expect(rowNamed("plan").querySelector(".codicon-check")).toBeTruthy()
    rerender(<ModelPicker {...baseProps} selection={{}} />)
    expect(rowNamed("default").querySelector(".codicon-check")).toBeTruthy()
    expect(rowNamed("plan").querySelector(".codicon-check")).toBeNull()
  })

  it("Enter on an agent row reached by arrow keys picks it", () => {
    const onSetAgent = vi.fn()
    const onSetModel = vi.fn()
    render(<ModelPicker {...baseProps} onSetAgent={onSetAgent} onSetModel={onSetModel} />)
    const input = screen.getByRole("textbox", { name: "Search models and agents" })
    fireEvent.keyDown(input, { key: "ArrowUp" })
    fireEvent.keyDown(input, { key: "ArrowUp" })
    expect(rowNamed("build").getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSetAgent).toHaveBeenCalledWith("build")
    expect(onSetModel).not.toHaveBeenCalled()
  })

  it("shows the agent description muted after the name and as the row tooltip", () => {
    render(<ModelPicker {...baseProps} />)
    const build = rowNamed("build")
    expect(build.querySelector(".model-picker-desc")!.textContent).toBe("makes changes")
    expect(build.getAttribute("title")).toBe("makes changes")
    // The check slot leads every agent row too, so names align with the models.
    expect(build.firstElementChild!.className).toBe("model-picker-check")
    expect(rowNamed("plan").querySelector(".model-picker-desc")).toBeNull()
  })

  it("a search matches agent names but not descriptions; the default agent row leaves with it", () => {
    render(<ModelPicker {...baseProps} />)
    const input = screen.getByRole("textbox", { name: "Search models and agents" })
    fireEvent.change(input, { target: { value: "plan" } })
    // No model matches, and that still shows — the agent match renders below it.
    expect(screen.getByText(/No models match/)).toBeInTheDocument()
    expect(rowNames()).toEqual(["plan"])
    fireEvent.change(input, { target: { value: "changes" } })
    expect(screen.queryAllByRole("option")).toHaveLength(0)
    expect(screen.queryByText("Agent")).toBeNull()
    fireEvent.change(input, { target: { value: "" } })
    expect(rowNames().slice(-3)).toEqual(["default", "build", "plan"])
  })

  it("renders no Agent section when the catalog reports no agents", () => {
    render(<ModelPicker {...baseProps} catalog={{ ...catalog, agents: [] }} />)
    expect(screen.queryByText("Agent")).toBeNull()
    expect(rowNames()).not.toContain("default")
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
    expect(rowNames()).toEqual([
      "gpt-5.5",
      "claude-sonnet-4-6",
      "gpt-5.5",
      "gemini-3-pro",
      "opencode default",
      "default",
      "build",
      "plan",
    ])
    // Focus handed back to the search line so arrows keep working (chip pattern).
    expect(screen.getByRole("textbox", { name: "Search models and agents" })).toHaveFocus()
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
    const input = screen.getByRole("textbox", { name: "Search models and agents" })
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
    const input = screen.getByRole("textbox", { name: "Search models and agents" })
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
    // No agents, so the default model row is the list's tail.
    render(<ModelPicker {...baseProps} catalog={{ ...catalog, agents: [] }} onSetModel={onSetModel} />)
    const input = screen.getByRole("textbox", { name: "Search models and agents" })
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
