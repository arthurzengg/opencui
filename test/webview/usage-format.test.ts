import { describe, it, expect } from "vitest"
import { tokenTotal, usageSummary, usageDetail } from "../../webview/src/usage-format"

describe("usageSummary", () => {
  it("shows only the cost when the model reports one", () => {
    expect(usageSummary({ model: "deepseek/deepseek-v4-pro", cost: 0.0051, tokens: { input: 9000, output: 930, reasoning: 0 } })).toBe("$0.0051")
  })

  it("falls back to the grouped token total when there is no cost", () => {
    expect(usageSummary({ model: "local/llama", cost: 0, tokens: { input: 9000, output: 930, reasoning: 0 } })).toBe("9,930 tokens")
  })

  it("falls back to the model when there is neither cost nor tokens", () => {
    expect(usageSummary({ model: "local/llama" })).toBe("local/llama")
    expect(usageSummary({})).toBeUndefined()
    expect(usageSummary(undefined)).toBeUndefined()
  })
})

describe("usageDetail", () => {
  it("lists model, cost with total, and the per-kind split", () => {
    const text = usageDetail({
      model: "deepseek/deepseek-v4-pro",
      cost: 0.0051,
      tokens: { input: 8120, output: 1810, reasoning: 310, cacheRead: 5000, cacheWrite: 200 },
    })
    expect(text.split("\n")).toEqual([
      "deepseek/deepseek-v4-pro",
      "$0.0051 · 9,930 tokens",
      "8,120 in · 1,810 out · 310 reasoning · 5,000 cache read · 200 cache write",
    ])
  })

  it("omits token kinds that are zero or absent", () => {
    const text = usageDetail({ model: "m", tokens: { input: 100, output: 50, reasoning: 0 } })
    expect(text).toBe("m\n150 tokens\n100 in · 50 out")
  })

  it("keeps the total as input plus output", () => {
    expect(tokenTotal({ tokens: { input: 1, output: 2, reasoning: 99, cacheRead: 7 } })).toBe(3)
    expect(tokenTotal({})).toBe(0)
  })
})
