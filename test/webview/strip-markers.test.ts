import { describe, it, expect } from "vitest"
import { stripInternalMarkers, splitWithReminders } from "../../webview/src/process-text"

describe("stripInternalMarkers", () => {
  it("returns input unchanged when no markers present", () => {
    expect(stripInternalMarkers("hello world")).toBe("hello world")
  })

  it("removes single-line system-reminder blocks", () => {
    const input = "before <system-reminder>internal</system-reminder> after"
    expect(stripInternalMarkers(input)).toBe("before  after")
  })

  it("removes multi-line system-reminder blocks", () => {
    const input = `text before
<system-reminder>
[ALL BACKGROUND TASKS COMPLETE]
- bg_a3998aef
</system-reminder>
text after`
    const result = stripInternalMarkers(input)
    expect(result).not.toContain("system-reminder")
    expect(result).not.toContain("BACKGROUND")
    expect(result).toContain("text before")
    expect(result).toContain("text after")
  })

  it("removes stray opening/closing system-reminder tags", () => {
    expect(stripInternalMarkers("text <system-reminder> more")).toBe("text  more")
    expect(stripInternalMarkers("text </system-reminder> more")).toBe("text  more")
  })

  it("removes HTML comments", () => {
    expect(stripInternalMarkers("foo <!-- OMO_INTERNAL --> bar")).toBe("foo  bar")
    expect(stripInternalMarkers("foo <!-- multi\nline\ncomment --> bar")).toBe("foo  bar")
  })

  it("removes command-* tags and similar harness scaffolding", () => {
    expect(stripInternalMarkers("a <command-name>/foo</command-name> b")).toBe("a  b")
    expect(stripInternalMarkers("a <command-message>x</command-message> b")).toBe("a  b")
    expect(stripInternalMarkers("a <command-args></command-args> b")).toBe("a  b")
    expect(stripInternalMarkers("a <local-command-stdout>out</local-command-stdout> b")).toBe("a  b")
    expect(stripInternalMarkers("a <user-prompt-submit-hook>x</user-prompt-submit-hook> b")).toBe("a  b")
  })

  it("collapses excessive blank lines after stripping", () => {
    const input = "line1\n\n\n\n<system-reminder>\nx\n</system-reminder>\n\n\nline2"
    const result = stripInternalMarkers(input)
    expect(result).not.toMatch(/\n{3,}/)
  })

  it("trims leading/trailing whitespace after strip", () => {
    expect(stripInternalMarkers("  \n<system-reminder>x</system-reminder>\n  ")).toBe("")
  })

  it("preserves real content inside non-marker tags", () => {
    expect(stripInternalMarkers("Use <em>this</em> code")).toBe("Use <em>this</em> code")
  })

  it("handles mixed markers and content", () => {
    const input = "Hello\n<system-reminder>\ninternal stuff\n</system-reminder>\n<!-- comment -->\nWorld"
    const result = stripInternalMarkers(input)
    expect(result).toBe("Hello\n\nWorld")
  })

  it("matches system-reminder tags with attributes", () => {
    expect(stripInternalMarkers('a <system-reminder type="warning">x</system-reminder> b')).toBe("a  b")
  })
})

describe("splitWithReminders", () => {
  it("returns a single text segment when no reminders are present", () => {
    expect(splitWithReminders("hello world")).toEqual([{ type: "text", content: "hello world" }])
  })

  it("returns nothing for empty / whitespace-only input", () => {
    expect(splitWithReminders("")).toEqual([])
    expect(splitWithReminders("   \n  ")).toEqual([])
  })

  it("splits text and reminder into separate segments", () => {
    expect(splitWithReminders("before <system-reminder>r1</system-reminder> after")).toEqual([
      { type: "text", content: "before " },
      { type: "reminder", content: "r1" },
      { type: "text", content: " after" },
    ])
  })

  it("preserves multiple reminders in document order", () => {
    const input = "A <system-reminder>1</system-reminder> B <system-reminder>2</system-reminder> C"
    expect(splitWithReminders(input)).toEqual([
      { type: "text", content: "A " },
      { type: "reminder", content: "1" },
      { type: "text", content: " B " },
      { type: "reminder", content: "2" },
      { type: "text", content: " C" },
    ])
  })

  it("accepts reminder tags with attributes", () => {
    const input = '<system-reminder type="note">payload</system-reminder>'
    expect(splitWithReminders(input)).toEqual([{ type: "reminder", content: "payload" }])
  })

  it("trims the reminder content but keeps internal newlines", () => {
    const input = "<system-reminder>\n  hello\n  world\n</system-reminder>"
    expect(splitWithReminders(input)).toEqual([
      { type: "reminder", content: "hello\n  world" },
    ])
  })

  it("still strips noise markers (HTML comments, command-name) entirely", () => {
    const input = "before <!-- comment --> mid <command-name>/x</command-name> after"
    expect(splitWithReminders(input)).toEqual([
      { type: "text", content: "before  mid  after" },
    ])
  })

  it("collapses excessive blank lines in text segments", () => {
    const input = "line1\n\n\n\n<system-reminder>r</system-reminder>\n\n\n\nline2"
    const out = splitWithReminders(input)
    expect(out).toEqual([
      { type: "text", content: "line1" },
      { type: "reminder", content: "r" },
      { type: "text", content: "line2" },
    ])
  })

  it("drops empty reminder segments", () => {
    expect(splitWithReminders("a <system-reminder></system-reminder> b")).toEqual([
      { type: "text", content: "a " },
      { type: "text", content: " b" },
    ])
  })

  it("drops stray closing tags without losing surrounding text", () => {
    expect(splitWithReminders("hello </system-reminder> world")).toEqual([
      { type: "text", content: "hello  world" },
    ])
  })
})
