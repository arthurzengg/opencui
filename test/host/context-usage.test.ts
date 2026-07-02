import { describe, expect, it } from "vitest"
import { contextUsageFromMessages } from "../../src/chat/context-usage"

describe("contextUsageFromMessages", () => {
  it("matches opencode's context calculation from the latest assistant token usage", () => {
    const usage = contextUsageFromMessages(
      [
        {
          info: {
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-5",
            cost: 0.01,
            tokens: { input: 1_000, output: 500, reasoning: 200, cache: { read: 100, write: 50 } },
          },
        },
        {
          info: {
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-5",
            cost: 0.02,
            tokens: { input: 10_000, output: 2_000, reasoning: 1_000, cache: { read: 500, write: 500 } },
          },
        },
      ],
      [
        {
          id: "openai",
          models: {
            "gpt-5": { limit: { context: 200_000 } },
          },
        },
      ],
    )

    expect(usage).toMatchObject({
      tokens: 14_000,
      limit: 200_000,
      percent: 7,
      model: "openai/gpt-5",
    })
    expect(usage?.cost).toBeCloseTo(0.03)
  })

  it("returns undefined until an assistant message has output tokens", () => {
    expect(
      contextUsageFromMessages(
        [{ info: { role: "assistant", tokens: { input: 100, output: 0 } } }],
        [],
      ),
    ).toBeUndefined()
  })
})
