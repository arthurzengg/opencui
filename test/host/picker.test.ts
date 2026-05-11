import { describe, it, expect } from "vitest"
import { isUserSelectableAgent } from "../../src/picker"

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
