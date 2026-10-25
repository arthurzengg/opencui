import { describe, it, expect } from "vitest"
import { processTitle } from "../../webview/src/process-text"
import type { ChatBlock } from "../../webview/src/protocol"

const reasoning = (text: string): ChatBlock => ({ type: "reasoning", text })
const read: ChatBlock = {
  type: "tool",
  update: { callID: "c1", tool: "read", status: "completed", input: { filePath: "a.ts" } },
}

describe("processTitle on a live message", () => {
  it("reads the streaming first line as the title only once a newline closes it", () => {
    expect(processTitle([reasoning("Let me look at the stream")], true).title).toBe("Working")
    expect(processTitle([reasoning("Let me look at the stream\nIt subscribes once.")], true)).toEqual({
      title: "Let me look at the stream",
      source: 0,
    })
  })

  it("treats a block before the last one, and any block of a settled message, as complete", () => {
    expect(processTitle([reasoning("Let me look at the stream"), read], true).title).toBe("Let me look at the stream")
    expect(processTitle([reasoning("Let me look at the stream")], false).title).toBe("Let me look at the stream")
  })
})
