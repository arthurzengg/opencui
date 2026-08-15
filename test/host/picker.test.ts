import { describe, it, expect } from "vitest"
import { buildModelCatalog, isUserSelectableAgent, listModels, validVariant } from "../../src/picker"

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

describe("listModels", () => {
  it("yields one entry per model with an empty variants list when none are declared", () => {
    const models = listModels([
      { id: "p1", name: "Provider 1", models: { "model-a": {}, "model-b": {} } },
    ])
    expect(models).toEqual([
      { providerID: "p1", modelID: "model-a", providerName: "Provider 1", variants: [] },
      { providerID: "p1", modelID: "model-b", providerName: "Provider 1", variants: [] },
    ])
  })

  it("attaches variant keys (in declared order) without exploding the row count", () => {
    const models = listModels([
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-5.5": { variants: { minimal: {}, low: {}, medium: {}, high: {}, xhigh: {} } },
        },
      },
    ])
    expect(models).toHaveLength(1)
    expect(models[0]).toEqual({
      providerID: "openai",
      modelID: "gpt-5.5",
      providerName: "OpenAI",
      variants: ["minimal", "low", "medium", "high", "xhigh"],
    })
  })

  it("handles a mix of variant-having and variant-less models in one provider", () => {
    const models = listModels([
      {
        id: "anthropic",
        models: {
          "claude-opus": { variants: { high: {}, max: {} } },
          "claude-haiku": {},
        },
      },
    ])
    expect(models.map((m) => `${m.modelID}: ${m.variants.join(",")}`)).toEqual([
      "claude-opus: high,max",
      "claude-haiku: ",
    ])
  })

  it("returns an empty list for an empty provider list", () => {
    expect(listModels([])).toEqual([])
  })

  it("tolerates missing models/variants fields", () => {
    const models = listModels([
      { id: "p", models: undefined },
      { id: "q", models: { x: { variants: undefined } } },
    ])
    expect(models).toEqual([{ providerID: "q", modelID: "x", providerName: undefined, variants: [] }])
  })
})


describe("validVariant", () => {
  const model = { providerID: "openai", modelID: "gpt-5.5", variants: ["low", "high"] }

  it("keeps a variant the model declares", () => {
    expect(validVariant(model, "high")).toBe("high")
  })

  it("drops a variant the model does not declare (stale memory, changed config)", () => {
    expect(validVariant(model, "max")).toBeUndefined()
  })

  it("passes undefined through", () => {
    expect(validVariant(model, undefined)).toBeUndefined()
  })

  it("trusts the variant when the model is unknown (catalog not loaded yet)", () => {
    expect(validVariant(undefined, "high")).toBe("high")
  })
})

describe("buildModelCatalog", () => {
  const models = [
    { providerID: "anthropic", modelID: "sonnet", providerName: "Anthropic", variants: ["max"] },
    { providerID: "openai", modelID: "gpt-5.5", providerName: "OpenAI", variants: ["low", "high"] },
  ]

  it("attaches validated per-model variant memory as lastVariant", () => {
    const memory: Record<string, string | undefined> = {
      "anthropic/sonnet": "max",
      "openai/gpt-5.5": "xhigh", // no longer declared — must not survive
    }
    const catalog = buildModelCatalog(models, [], (p, m) => memory[`${p}/${m}`], [])
    expect(catalog.models.map((m) => m.lastVariant)).toEqual(["max", undefined])
  })

  it("filters recents to models that still exist, preserving order", () => {
    const catalog = buildModelCatalog(
      models,
      ["openai/gpt-5.5", "meta/removed-model", "anthropic/sonnet"],
      () => undefined,
      [],
    )
    expect(catalog.recents).toEqual(["openai/gpt-5.5", "anthropic/sonnet"])
  })

  it("passes the agent entries through for the picker's Agent chips", () => {
    const agents = [{ name: "build", description: "makes changes" }, { name: "plan" }]
    expect(buildModelCatalog(models, [], () => undefined, agents).agents).toEqual(agents)
  })
})
