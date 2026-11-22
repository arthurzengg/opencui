import { describe, it, expect } from "vitest"
import { tokenTotal, turnUsage, usageSummary, usageBreakdown, usageDetail } from "../../webview/src/usage-format"

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

// Recorded from a 1.18.30 session: three steps of one turn, each an assistant
// message with its own usage. The provider billed all three (#792).
describe("turnUsage", () => {
  const steps = [
    { model: "anthropic/claude-sonnet-5-5", cost: 0.0377, tokens: { input: 4, output: 327, reasoning: 369, cacheRead: 94721, cacheWrite: 8513 } },
    { model: "anthropic/claude-sonnet-5-5", cost: 0.0579, tokens: { input: 2, output: 167, reasoning: 650, cacheRead: 103234, cacheWrite: 15770 } },
    { model: "anthropic/claude-sonnet-5-5", cost: 0.0248, tokens: { input: 2, output: 627, reasoning: 296, cacheRead: 129929, cacheWrite: 1041 } },
  ]

  it("adds up every step of the turn, not only the last", () => {
    const usage = turnUsage(steps)!
    expect(usage.cost).toBeCloseTo(0.1204, 6)
    expect(usage.tokens).toEqual({ input: 8, output: 1121, reasoning: 1315, cacheRead: 327884, cacheWrite: 25324 })
    expect(usage.model).toBe("anthropic/claude-sonnet-5-5")
  })

  it("skips a step that reported nothing, such as a stopped one", () => {
    expect(turnUsage([steps[0], undefined, steps[2], undefined])!.cost).toBeCloseTo(0.0625, 6)
    expect(turnUsage([undefined])).toBeUndefined()
  })
})
