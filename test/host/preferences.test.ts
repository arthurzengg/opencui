import { describe, it, expect } from "vitest"
import * as vscode from "vscode"
import { Preferences } from "../../src/preferences"

function makePrefs() {
  const store = new Map<string, unknown>()
  const memento = {
    keys: () => [...store.keys()],
    get: (key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue),
    update: async (key: string, value: unknown) => {
      if (value === undefined) store.delete(key)
      else store.set(key, value)
    },
  }
  return new Preferences(memento as unknown as vscode.Memento)
}

describe("Preferences model recents", () => {
  it("records picks most-recent-first and dedups re-picks", async () => {
    const prefs = makePrefs()
    await prefs.setModel("anthropic", "sonnet")
    await prefs.setModel("openai", "gpt-5.5")
    await prefs.setModel("anthropic", "sonnet")
    expect(prefs.recentModels()).toEqual(["anthropic/sonnet", "openai/gpt-5.5"])
  })

  it("caps the list at six entries, dropping the oldest", async () => {
    const prefs = makePrefs()
    for (let i = 1; i <= 7; i++) await prefs.setModel("p", `model-${i}`)
    const recents = prefs.recentModels()
    expect(recents).toHaveLength(6)
    expect(recents[0]).toBe("p/model-7")
    expect(recents).not.toContain("p/model-1")
  })

  it("a reset to the opencode default records nothing", async () => {
    const prefs = makePrefs()
    await prefs.setModel("anthropic", "sonnet")
    await prefs.setModel(undefined, undefined, undefined)
    expect(prefs.recentModels()).toEqual(["anthropic/sonnet"])
    expect(prefs.get().modelID).toBeUndefined()
  })
})

describe("Preferences per-model variant memory", () => {
  it("remembers the last variant per model, independently across models", async () => {
    const prefs = makePrefs()
    await prefs.setModel("anthropic", "sonnet", "max")
    await prefs.setModel("openai", "gpt-5.5", "high")
    expect(prefs.variantFor("anthropic", "sonnet")).toBe("max")
    expect(prefs.variantFor("openai", "gpt-5.5")).toBe("high")
  })

  it("an explicit default-effort pick clears that model's memory", async () => {
    const prefs = makePrefs()
    await prefs.setModel("anthropic", "sonnet", "max")
    await prefs.setModel("anthropic", "sonnet", undefined)
    expect(prefs.variantFor("anthropic", "sonnet")).toBeUndefined()
  })

  it("memory survives switching to another model (the point of the feature)", async () => {
    const prefs = makePrefs()
    await prefs.setModel("anthropic", "sonnet", "max")
    await prefs.setModel("openai", "gpt-5.5")
    expect(prefs.variantFor("anthropic", "sonnet")).toBe("max")
  })

  it("tolerates corrupt persisted shapes for recents and memory", () => {
    const store = new Map<string, unknown>([
      ["opencui.model.recents", "not-an-array"],
      ["opencui.model.variantMemory", [1, 2, 3]],
      ["opencui.model.collapsedProviders", "not-an-array"],
    ])
    const memento = {
      keys: () => [...store.keys()],
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => void store.set(key, value),
    }
    const prefs = new Preferences(memento as unknown as vscode.Memento)
    expect(prefs.recentModels()).toEqual([])
    expect(prefs.variantFor("a", "b")).toBeUndefined()
    expect(prefs.collapsedProviders()).toEqual([])
  })
})

describe("Preferences folded picker providers", () => {
  it("folds and unfolds a provider, deduping repeat folds", async () => {
    const prefs = makePrefs()
    await prefs.setProviderCollapsed("openai", true)
    await prefs.setProviderCollapsed("anthropic", true)
    await prefs.setProviderCollapsed("openai", true)
    expect(prefs.collapsedProviders()).toEqual(["anthropic", "openai"])
    await prefs.setProviderCollapsed("openai", false)
    expect(prefs.collapsedProviders()).toEqual(["anthropic"])
  })
})
