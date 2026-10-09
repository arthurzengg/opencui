import { describe, expect, it, vi } from "vitest"
import { getOutputChannel, log } from "../../src/output"

describe("log", () => {
  // JSON.stringify(new Error("boom")) is "{}", which is what the output
  // channel showed for every failure that reached log() as an Error (#691).
  it("writes an Error by name, message, and stack instead of {}", () => {
    const channel = getOutputChannel() as unknown as { appendLine: ReturnType<typeof vi.fn> }
    log("failed to start backend", new Error("boom"))
    const line = channel.appendLine.mock.calls.at(-1)![0] as string
    expect(line).toContain("failed to start backend Error: boom")
    expect(line).not.toContain("{}")
  })
})
