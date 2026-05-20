import { describe, it, expect } from "vitest"
import { taskTitleFromUpdate, summarizePrompt } from "../../src/chat/view"
import type { ToolUpdate } from "../../src/chat/stream"

function makeUpdate(overrides: Partial<ToolUpdate> = {}): ToolUpdate {
  return {
    callID: "c1",
    tool: "task",
    status: "running",
    ...overrides,
  }
}

describe("taskTitleFromUpdate", () => {
  it("prefers input.description when it is a non-empty string", () => {
    expect(
      taskTitleFromUpdate(makeUpdate({ input: { description: "Fix TS errors" } })),
    ).toBe("Fix TS errors")
  })

  it("falls back to update.title when description is missing", () => {
    expect(taskTitleFromUpdate(makeUpdate({ title: "Hephaestus run" }))).toBe("Hephaestus run")
  })

  it("uses 'Background agent' as the last-resort title", () => {
    expect(taskTitleFromUpdate(makeUpdate({}))).toBe("Background agent")
  })

  it("ignores non-string description fields", () => {
    expect(taskTitleFromUpdate(makeUpdate({ input: { description: 5 } }))).toBe("Background agent")
  })

  it("trims whitespace-only descriptions", () => {
    expect(
      taskTitleFromUpdate(makeUpdate({ input: { description: "   " }, title: "Fallback" })),
    ).toBe("Fallback")
  })
})

describe("summarizePrompt", () => {
  it("collapses whitespace and caps at 64 characters", () => {
    const text = "  Fix   TypeScript    errors  in the build  "
    expect(summarizePrompt(text)).toBe("Fix TypeScript errors in the build")
  })

  it("truncates long prompts", () => {
    const text = "a".repeat(200)
    expect(summarizePrompt(text).length).toBe(64)
  })

  it("falls back to 'Main agent' when text is empty", () => {
    expect(summarizePrompt("")).toBe("Main agent")
    expect(summarizePrompt("   ")).toBe("Main agent")
  })
})
