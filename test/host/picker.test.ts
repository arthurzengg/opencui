import { describe, it, expect } from "vitest"
import { isUserSelectableAgent, listModelRows, formatModelRow } from "../../src/picker"

describe("isUserSelectableAgent", () => {
  it("accepts a normal primary agent", () => {
    expect(isUserSelectableAgent({ name: "default", mode: "primary" })).toBe(true)
    expect(isUserSelectableAgent({ name: "code-reviewer", mode: "primary" })).toBe(true)
  })

  it("rejects subagents (only orchestrators surface as user-selectable)", () => {
    expect(isUserSelectableAgent({ name: "code-fixer", mode: "subagent" })).toBe(false)
  })

  it("rejects opencode's internal helper agents (compaction / summary / title)", () => {
    expect(isUserSelectableAgent({ name: "compaction", mode: "primary" })).toBe(false)
    expect(isUserSelectableAgent({ name: "summary", mode: "primary" })).toBe(false)
    expect(isUserSelectableAgent({ name: "title", mode: "primary" })).toBe(false)
  })

  it("matches internal-agent names case-insensitively", () => {
    expect(isUserSelectableAgent({ name: "Compaction", mode: "primary" })).toBe(false)
    expect(isUserSelectableAgent({ name: "SUMMARY", mode: "primary" })).toBe(false)
    expect(isUserSelectableAgent({ name: "Title", mode: "primary" })).toBe(false)
  })

  it("does not reject user agents that merely contain a system substring", () => {
    expect(isUserSelectableAgent({ name: "title-fixer", mode: "primary" })).toBe(true)
    expect(isUserSelectableAgent({ name: "summary-builder", mode: "primary" })).toBe(true)
  })

  it("treats missing fields gracefully (defaults to user-selectable)", () => {
    expect(isUserSelectableAgent({})).toBe(true)
    expect(isUserSelectableAgent({ name: "" })).toBe(true)
  })
})

describe("listModelRows", () => {
  it("yields one row per model when no variants exist", () => {
    const rows = listModelRows([
      { id: "p1", name: "Provider 1", models: { "model-a": {}, "model-b": {} } },
    ])
    expect(rows).toEqual([
      { providerID: "p1", modelID: "model-a", providerName: "Provider 1" },
      { providerID: "p1", modelID: "model-b", providerName: "Provider 1" },
    ])
  })

  it("emits the bare model row plus one row per variant key (in declared order)", () => {
    const rows = listModelRows([
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-5.5": {
            variants: { minimal: {}, low: {}, medium: {}, high: {} },
          },
        },
      },
    ])
    expect(rows.map(formatModelRow)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.5 · minimal",
      "openai/gpt-5.5 · low",
      "openai/gpt-5.5 · medium",
      "openai/gpt-5.5 · high",
    ])
    expect(rows[0]).toEqual({ providerID: "openai", modelID: "gpt-5.5", providerName: "OpenAI" })
    expect(rows[4]).toEqual({
      providerID: "openai",
      modelID: "gpt-5.5",
      providerName: "OpenAI",
      variant: "high",
    })
  })

  it("handles a mix of variant-having and variant-less models in one provider", () => {
    const rows = listModelRows([
      {
        id: "anthropic",
        models: {
          "claude-opus": { variants: { high: {}, max: {} } },
          "claude-haiku": {},
        },
      },
    ])
    expect(rows.map(formatModelRow)).toEqual([
      "anthropic/claude-opus",
      "anthropic/claude-opus · high",
      "anthropic/claude-opus · max",
      "anthropic/claude-haiku",
    ])
  })

  it("returns an empty list for an empty provider list", () => {
    expect(listModelRows([])).toEqual([])
  })

  it("tolerates missing models/variants fields", () => {
    const rows = listModelRows([
      { id: "p", models: undefined },
      { id: "q", models: { x: { variants: undefined } } },
    ])
    expect(rows.map(formatModelRow)).toEqual(["q/x"])
  })
})

describe("formatModelRow", () => {
  it("omits the separator when no variant is set", () => {
    expect(formatModelRow({ providerID: "openai", modelID: "gpt-5.5" })).toBe("openai/gpt-5.5")
  })

  it("renders the variant as a middot-separated suffix", () => {
    expect(formatModelRow({ providerID: "openai", modelID: "gpt-5.5", variant: "high" })).toBe(
      "openai/gpt-5.5 · high",
    )
  })
})
