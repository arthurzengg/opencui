import { describe, it, expect } from "vitest"
import { formatModel, formatAgent, formatUpdated } from "../../webview/src/components/StatusBar"

describe("formatModel", () => {
  it("returns 'default' for empty/default input", () => {
    expect(formatModel("")).toBe("default")
    expect(formatModel("default")).toBe("default")
  })

  it("strips provider prefix", () => {
    expect(formatModel("anthropic/claude-opus-4-7")).toBe("Opus 4.7")
    expect(formatModel("openai/gpt-4o")).toBe("GPT-4o")
  })

  it("formats Claude family with version-after-family", () => {
    expect(formatModel("claude-opus-4-7")).toBe("Opus 4.7")
    expect(formatModel("claude-sonnet-4-5")).toBe("Sonnet 4.5")
    expect(formatModel("claude-haiku-4-5")).toBe("Haiku 4.5")
  })

  it("formats Claude family with version-before-family (older naming)", () => {
    expect(formatModel("claude-3-5-sonnet")).toBe("Sonnet 3.5")
    expect(formatModel("claude-3-opus")).toBe("Opus 3")
  })

  it("strips trailing date suffixes from Claude names", () => {
    expect(formatModel("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5")
    expect(formatModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5")
    expect(formatModel("claude-opus-4-7-2026-04-13")).toBe("Opus 4.7")
  })

  it("formats GPT models", () => {
    expect(formatModel("gpt-4o")).toBe("GPT-4o")
    expect(formatModel("gpt-4-turbo")).toBe("GPT-4 Turbo")
    expect(formatModel("gpt-3.5-turbo")).toBe("GPT-3.5 Turbo")
    expect(formatModel("gpt-4o-mini")).toBe("GPT-4o Mini")
  })

  it("strips dates from GPT names", () => {
    expect(formatModel("gpt-4o-2024-08-06")).toBe("GPT-4o")
    expect(formatModel("gpt-4-turbo-2024-04-09")).toBe("GPT-4 Turbo")
  })

  it("formats Gemini models", () => {
    expect(formatModel("gemini-1.5-pro")).toBe("Gemini 1.5 Pro")
    expect(formatModel("gemini-2.0-flash")).toBe("Gemini 2.0 Flash")
  })

  it("title-cases unknown models", () => {
    expect(formatModel("custom-model-v2")).toBe("Custom Model V2")
  })

  it("truncates excessively long unknown names", () => {
    const longName = "very-long-unknown-model-with-many-words-and-continued"
    const result = formatModel(longName)
    expect(result.length).toBeLessThanOrEqual(25)
    expect(result.endsWith("…")).toBe(true)
  })
})

describe("formatAgent", () => {
  it("returns 'default' for empty/default input", () => {
    expect(formatAgent("")).toBe("default")
    expect(formatAgent("default")).toBe("default")
  })

  it("title-cases kebab-case agent names", () => {
    expect(formatAgent("code-reviewer")).toBe("Code Reviewer")
    expect(formatAgent("hephaestus-deep-agent")).toBe("Hephaestus Deep Agent")
  })

  it("title-cases snake_case", () => {
    expect(formatAgent("data_scientist")).toBe("Data Scientist")
  })

  it("preserves single words", () => {
    expect(formatAgent("planner")).toBe("Planner")
  })
})

describe("formatUpdated", () => {
  const now = Date.now()

  // formatUpdated renders dates in the viewer's locale on purpose, so the
  // expected string is built with the same Intl options rather than a
  // hardcoded English abbreviation: "Oct 2025" here, "ott 2025" under it-IT.
  // These assertions pin the *format* (which fields, which width), which is
  // the part the function actually decides.
  const weekday = (d: Date) => d.toLocaleDateString([], { weekday: "short" })
  const monthDay = (d: Date) => d.toLocaleDateString([], { month: "short", day: "numeric" })
  const monthYear = (d: Date) => d.toLocaleDateString([], { month: "short", year: "numeric" })

  it("renders 'just now' for very recent timestamps", () => {
    expect(formatUpdated(now - 5000)).toBe("just now")
    expect(formatUpdated(now - 28_000)).toBe("just now")
  })

  it("renders minutes for sub-hour timestamps", () => {
    expect(formatUpdated(now - 60_000)).toMatch(/^\d+m ago$/)
    expect(formatUpdated(now - 30 * 60_000)).toBe("30m ago")
  })

  it("renders hours for sub-day timestamps", () => {
    expect(formatUpdated(now - 60 * 60_000)).toBe("1h ago")
    expect(formatUpdated(now - 5 * 60 * 60_000)).toBe("5h ago")
  })

  it("renders 'yesterday' for timestamps at the start of yesterday's calendar day", () => {
    // Midnight yesterday is reliably (a) on yesterday's calendar day AND
    // (b) at least 24h ago, regardless of what time the test runs.
    const startOfYesterday = new Date()
    startOfYesterday.setHours(0, 0, 0, 0)
    startOfYesterday.setDate(startOfYesterday.getDate() - 1)
    expect(formatUpdated(startOfYesterday.getTime())).toBe("yesterday")
  })

  it("renders weekday for last 7 days", () => {
    const fourDaysAgo = new Date()
    fourDaysAgo.setDate(fourDaysAgo.getDate() - 4)
    fourDaysAgo.setHours(10, 0, 0, 0)
    expect(formatUpdated(fourDaysAgo.getTime())).toBe(weekday(fourDaysAgo))
    // A weekday name, not a date: no day number.
    expect(formatUpdated(fourDaysAgo.getTime())).not.toContain(String(fourDaysAgo.getDate()))
  })

  it("renders Mon Day for older same-year timestamps", () => {
    const sixMonthsAgo = new Date()
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
    if (sixMonthsAgo.getFullYear() === new Date().getFullYear()) {
      expect(formatUpdated(sixMonthsAgo.getTime())).toBe(monthDay(sixMonthsAgo))
    }
  })

  it("renders Mon Year for prior years", () => {
    const lastYear = new Date()
    lastYear.setFullYear(lastYear.getFullYear() - 1)
    const result = formatUpdated(lastYear.getTime())
    expect(result).toBe(monthYear(lastYear))
    // The year, not the day: this is the branch that drops the day number.
    expect(result).toContain(String(lastYear.getFullYear()))
    expect(result).not.toContain(String(lastYear.getDate()))
  })
})
