import { describe, it, expect } from "vitest"
import { tokenTotal, usageSummary, usageBreakdown, usageDetail } from "../../webview/src/usage-format"

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

describe("usageBreakdown", () => {
  it("lists the model, the totals, and the per-kind split as labelled rows", () => {
    const breakdown = usageBreakdown({
      model: "deepseek/deepseek-v4-pro",
      cost: 0.0051,
      tokens: { input: 8120, output: 1810, reasoning: 310, cacheRead: 5000, cacheWrite: 200 },
    })
    expect(breakdown).toEqual({
      model: "deepseek/deepseek-v4-pro",
      totals: [
        { label: "Cost", value: "$0.0051" },
        { label: "Tokens", value: "9,930" },
      ],
      kinds: [
        { label: "Input", value: "8,120" },
        { label: "Output", value: "1,810" },
        { label: "Reasoning", value: "310" },
        { label: "Cache read", value: "5,000" },
        { label: "Cache write", value: "200" },
      ],
    })
  })

  it("omits the cost row and the token kinds that are zero or absent", () => {
    expect(usageBreakdown({ model: "m", tokens: { input: 100, output: 50, reasoning: 0 } })).toEqual({
      model: "m",
      totals: [{ label: "Tokens", value: "150" }],
      kinds: [
        { label: "Input", value: "100" },
        { label: "Output", value: "50" },
      ],
    })
  })

  it("keeps the total as input plus output", () => {
    expect(tokenTotal({ tokens: { input: 1, output: 2, reasoning: 99, cacheRead: 7 } })).toBe(3)
    expect(tokenTotal({})).toBe(0)
  })
})

describe("usageDetail", () => {
  it("flattens the same rows into the accessible label", () => {
    expect(usageDetail({ model: "m", cost: 0.0051, tokens: { input: 100, output: 50, reasoning: 0 } })).toBe("m, Cost $0.0051, Tokens 150, Input 100, Output 50")
  })
})
