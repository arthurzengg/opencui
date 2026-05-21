import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { startMockOpencode, type MockOpencodeServer } from "./mock-opencode-server"
import { subscribeSession, type ChildSessionEvent } from "../../src/chat/stream"

let server: MockOpencodeServer

beforeEach(async () => {
  server = await startMockOpencode()
})

afterEach(async () => {
  await server.close()
})

describe("subscribeSession: child-session tool/patch routing", () => {
  it("forwards a terminal tool event from a registered child to onChildSessionEvent", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const events: ChildSessionEvent[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionEvent: (e) => events.push(e),
    })
    await subscription.ready
    await server.awaitClient()
    subscription.addChildSession("ses_child_a")
    // Push a child tool event that has completed (e.g. an edit tool emitting
    // its filediff metadata).
    server.push({
      type: "message.part.updated",
      part: {
        id: "p1",
        messageID: "msg_child_1",
        sessionID: "ses_child_a",
        type: "tool",
        callID: "call_edit_1",
        tool: "edit",
        state: {
          status: "completed",
          input: { filePath: "src/sub.ts" },
          metadata: { filediff: { patch: "@@\n+x", additions: 1, deletions: 0 } },
        },
      },
    } as never)
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    const tool = events.find((e) => e.type === "tool")
    expect(tool).toBeDefined()
    if (tool && tool.type === "tool") {
      expect(tool.sessionID).toBe("ses_child_a")
      expect(tool.messageID).toBe("msg_child_1")
      expect(tool.update.callID).toBe("call_edit_1")
      expect(tool.update.tool).toBe("edit")
      expect(tool.update.status).toBe("completed")
      expect((tool.update.metadata?.filediff as Record<string, unknown>)?.patch).toBe("@@\n+x")
    }
  })

  it("skips tool events that haven't reached a terminal status yet", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const events: ChildSessionEvent[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionEvent: (e) => events.push(e),
    })
    await subscription.ready
    await server.awaitClient()
    subscription.addChildSession("ses_child_b")
    server.push({
      type: "message.part.updated",
      part: {
        id: "p1",
        messageID: "msg_child_1",
        sessionID: "ses_child_b",
        type: "tool",
        callID: "call_edit_1",
        tool: "edit",
        state: { status: "running" },
      },
    } as never)
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    const toolEvents = events.filter((e) => e.type === "tool")
    expect(toolEvents).toHaveLength(0)
    // But it still counts as busy:
    expect(events.find((e) => e.type === "busy")).toBeDefined()
  })

  it("forwards a child patch event with files + diff", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const events: ChildSessionEvent[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionEvent: (e) => events.push(e),
    })
    await subscription.ready
    await server.awaitClient()
    subscription.addChildSession("ses_child_c")
    server.push({
      type: "message.part.updated",
      part: {
        id: "p2",
        messageID: "msg_child_2",
        sessionID: "ses_child_c",
        type: "patch",
        files: ["a.ts", "b.ts"],
        diff: "diff --git a/a.ts b/a.ts\n@@\n+x",
      },
    } as never)
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    const patch = events.find((e) => e.type === "patch")
    expect(patch).toBeDefined()
    if (patch && patch.type === "patch") {
      expect(patch.sessionID).toBe("ses_child_c")
      expect(patch.messageID).toBe("msg_child_2")
      expect(patch.files).toEqual(["a.ts", "b.ts"])
      expect(patch.diff).toContain("diff --git")
    }
  })

  it("does NOT forward child tool/patch events for unregistered children", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const events: ChildSessionEvent[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionEvent: (e) => events.push(e),
    })
    await subscription.ready
    await server.awaitClient()
    // Note: NO addChildSession call
    server.push({
      type: "message.part.updated",
      part: {
        id: "p_orphan",
        messageID: "m_orphan",
        sessionID: "ses_other",
        type: "tool",
        callID: "c_orphan",
        tool: "edit",
        state: { status: "completed" },
      },
    } as never)
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(events.filter((e) => e.type === "tool" || e.type === "patch")).toHaveLength(0)
  })
})
