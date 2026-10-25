import { describe, it, expect } from "vitest"
import { processSummary, processTitle } from "../../webview/src/process-text"
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

describe("process counts leave subagent work to its dispatch row", () => {
  it("count the parent's own calls only", () => {
    const explore = { kind: "subagent", sessionID: "ses_child", subagent: "explore", callID: "call_task" } as const
    const blocks: ChatBlock[] = [
      { type: "tool", update: { callID: "call_task", tool: "task", status: "completed", input: { description: "Find it" } } },
      { type: "tool", update: { callID: "c1", tool: "read", status: "completed", input: { filePath: "a.ts" } }, actor: explore },
      { type: "tool", update: { callID: "c2", tool: "read", status: "completed", input: { filePath: "b.ts" } }, actor: explore },
    ]
    expect(processSummary(blocks)).toBe("1 tool")
    expect(processTitle(blocks, true).title).toBe("Used 1 tool")
  })
})
