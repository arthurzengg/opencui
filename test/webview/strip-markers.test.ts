import { describe, it, expect } from "vitest"
import { stripInternalMarkers } from "../../webview/src/components/MessageView"

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
})
