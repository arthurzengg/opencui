import { describe, it, expect } from "vitest"
import {
  isSystemReminderTool,
  systemReminderContentFromTool,
} from "../../webview/src/process-text"

describe("isSystemReminderTool", () => {
  it.each([
    "system-reminder",
    "<system-reminder>",
    "system_reminder",
    "systemreminder",
    "System-Reminder",
    "SYSTEM-REMINDER",
  ])("matches %s", (name) => {
    expect(isSystemReminderTool(name)).toBe(true)
  })

  it.each(["read", "edit", "bash", "system-other", "", undefined])(
    "does not match %s",
    (name) => {
      expect(isSystemReminderTool(name)).toBe(false)
    },
  )
})

describe("systemReminderContentFromTool", () => {
  it("prefers output when present", () => {
    expect(
      systemReminderContentFromTool({
        output: "  remember this  ",
        input: { text: "ignored" },
      }),
    ).toBe("remember this")
  })

  it("falls back to known input string keys in priority order", () => {
    expect(systemReminderContentFromTool({ input: { content: "from content" } })).toBe("from content")
    // `text` should win over `body` when both present.
    expect(
      systemReminderContentFromTool({ input: { body: "ignored", text: "from text" } }),
    ).toBe("from text")
  })

  it("stringifies unknown-shape input as a last resort before title", () => {
    const out = systemReminderContentFromTool({
      input: { weird: "shape", n: 7 },
      title: "Not used because we have input",
    })
    expect(out).toContain("weird")
    expect(out).toContain("shape")
  })

  it("uses title only when nothing else is available", () => {
    expect(systemReminderContentFromTool({ title: "fallback" })).toBe("fallback")
  })

  it("returns empty string when there is nothing usable", () => {
    expect(systemReminderContentFromTool({})).toBe("")
    expect(systemReminderContentFromTool({ input: {} })).toBe("")
    expect(systemReminderContentFromTool({ output: "   " })).toBe("")
  })
})
