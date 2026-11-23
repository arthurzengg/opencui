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
    expect(processTitle([reasoning("Let me look at the stream")], true).title).toBe("Thinking")
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

describe("process counts leave a subagent's calls to its row", () => {
  // A turn that ran an agent used to fold to "Used 1 tool", and to "Read 1"
  // beside a read: the agent's work vanished from the summary (#796).
  it("count the parent's own calls, and the agents it started", () => {
    const explore = { kind: "subagent", sessionID: "ses_child", subagent: "explore", callID: "call_task" } as const
    const blocks: ChatBlock[] = [
      { type: "tool", update: { callID: "call_task", tool: "task", status: "completed", input: { description: "Find it" } } },
      { type: "tool", update: { callID: "c1", tool: "read", status: "completed", input: { filePath: "a.ts" } }, actor: explore },
      { type: "tool", update: { callID: "c2", tool: "read", status: "completed", input: { filePath: "b.ts" } }, actor: explore },
    ]
    expect(processSummary(blocks)).toBe("1 agent")
    expect(processTitle(blocks, true).title).toBe("Used 1 tool")
    const withRead: ChatBlock[] = [
      { type: "tool", update: { callID: "c0", tool: "read", status: "completed", input: { filePath: "view.ts" } } },
      ...blocks,
      { type: "tool", update: { callID: "call_2", tool: "subagent", status: "completed", input: { agent: "explore", description: "Check it" } } },
    ]
    expect(processSummary(withRead)).toBe("Read 1 · 2 agents")
  })
})

describe("collapsed summary", () => {
  it("names every part by its verb, then its count (#756)", () => {
    const call = (callID: string, tool: string, input: Record<string, unknown>): ChatBlock => ({
      type: "tool",
      update: { callID, tool, status: "completed", input },
    })
    const blocks = [
      call("c1", "read", { filePath: "a.ts" }),
      call("c2", "edit", { filePath: "b.ts", oldString: "x", newString: "y" }),
      call("c3", "grep", { pattern: "subscribe" }),
      call("c4", "glob", { pattern: "**/*.ts" }),
      call("c5", "bash", { command: "bun run test" }),
      call("c6", "webfetch", { url: "https://example.com" }),
    ]
    expect(processSummary(blocks)).toBe("Read 1 · Edited 1 · Searched 2 · Ran 1 · Fetched 1")
  })
})
