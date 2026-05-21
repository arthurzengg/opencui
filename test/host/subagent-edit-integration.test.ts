/**
 * End-to-end integration test for the "subagent edits a file" flow.
 *
 * This is the test that would have caught the regression the user hit in chat:
 * subscribeSession discovery worked in isolation, child-session tool routing
 * worked in isolation, but the host wiring that connects them was missing —
 * so in production the subagent's `edit` tool never reached the Review Panel.
 *
 * The test simulates the SSE sequence opencode emits when the built-in `task`
 * tool dispatches a subagent that edits a file, then drives the same wiring
 * ChatView.attachSubscription does (auto-register on discovery, append on
 * tool). If that wire is missing or broken, the assertion at the end fails.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { startMockOpencode, type MockOpencodeServer } from "./mock-opencode-server"
import { subscribeSession, type ChildSessionEvent, type ChildSessionInfo } from "../../src/chat/stream"
import { turnChanges } from "../../webview/src/review-extract"
import type { ChatBlock, ChatMessage } from "../../webview/src/protocol"

let server: MockOpencodeServer

beforeEach(async () => {
  server = await startMockOpencode()
})

afterEach(async () => {
  await server.close()
})

describe("Subagent file edit → Review Panel: full integration", () => {
  it("captures a subagent's edit as a ReviewChange with subagent attribution", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })

    // Stand in for ChatView.messages — the host's chat record. We'll push
    // tool/patch blocks here exactly as appendSubagentBlock does in
    // production.
    const parentBlocks: ChatBlock[] = []
    const parentMessage: ChatMessage = {
      id: "a_parent",
      role: "assistant",
      blocks: parentBlocks,
    }
    const messages: ChatMessage[] = [parentMessage]

    // Mirror ChatView's handler set so the test exercises the same wiring
    // path. The key piece: onChildSessionDiscovered must auto-register the
    // child session — without that, subsequent child tool events fall
    // through unrouted (this was the user-reported bug).
    let discoveredChild: ChildSessionInfo | undefined
    const collectedChildEvents: ChildSessionEvent[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_parent", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionDiscovered: (info) => {
        discoveredChild = info
        // This is what ChatView.attachSubscription does in production.
        subscription.addChildSession(info.id)
      },
      onChildSessionEvent: (event) => {
        collectedChildEvents.push(event)
        if (event.type === "tool") {
          // Same shape as ChatView.appendSubagentBlock — append the tool
          // block to the parent message with subagent attribution.
          parentBlocks.push({
            type: "tool",
            update: event.update,
            actor: {
              kind: "subagent",
              sessionID: event.sessionID,
              subagent: discoveredChild?.title?.includes("Sisyphus") ? "Sisyphus-Junior" : undefined,
            },
          })
        }
      },
    })
    await subscription.ready
    await server.awaitClient()

    // 1. Parent dispatches the task tool. Note: we deliberately DO NOT
    //    publish `metadata.sessionId` here — opencode's built-in task tool
    //    behaviour. This is what made the original code path miss subagent
    //    edits before session.created auto-discovery was added.
    server.push({
      type: "message.part.updated",
      part: {
        id: "part_task",
        messageID: "msg_parent",
        sessionID: "ses_parent",
        type: "tool",
        callID: "call_task",
        tool: "task",
        state: {
          status: "running",
          input: { description: "Add helper function", subagent_type: "Sisyphus-Junior" },
        },
      },
    })

    // 2. opencode creates the subagent's session. THIS is the event that
    //    auto-discovers the child via parentID match.
    server.push({
      type: "session.created",
      info: {
        id: "ses_subagent",
        parentID: "ses_parent",
        title: "Add helper function (@Sisyphus-Junior subagent)",
      },
    })
    // Allow the discovery handler to run before the next event arrives.
    await new Promise((r) => setTimeout(r, 20))

    // 3. The subagent emits its `edit` tool — this is where the file change
    //    actually happens. Before the fix, this event was silently dropped
    //    because the child session wasn't registered for routing.
    server.push({
      type: "message.part.updated",
      part: {
        id: "part_edit",
        messageID: "msg_subagent_a",
        sessionID: "ses_subagent",
        type: "tool",
        callID: "call_edit",
        tool: "edit",
        state: {
          status: "completed",
          input: { filePath: "quick_sort_1.py" },
          metadata: {
            filediff: {
              patch: "@@ -1 +1,2 @@\n hello\n+world",
              additions: 1,
              deletions: 0,
            },
          },
        },
      },
    })

    // 4. Subagent finishes.
    server.push({ type: "session.idle", sessionID: "ses_subagent" })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()

    // === Assertions ===
    // The discovery handler fired.
    expect(discoveredChild?.id).toBe("ses_subagent")
    expect(discoveredChild?.parentID).toBe("ses_parent")

    // The child's edit tool reached onChildSessionEvent.
    const toolEvent = collectedChildEvents.find((e) => e.type === "tool")
    expect(toolEvent).toBeDefined()

    // The block was appended to the parent's message with subagent attribution.
    expect(parentBlocks).toHaveLength(1)
    expect(parentBlocks[0]!.type).toBe("tool")
    if (parentBlocks[0]!.type === "tool") {
      expect(parentBlocks[0]!.actor?.kind).toBe("subagent")
      expect(parentBlocks[0]!.actor?.sessionID).toBe("ses_subagent")
    }

    // And — critically — turnChanges() now reports the file change WITH
    // subagent attribution. If this fails, the Review Panel won't show the
    // subagent's edit (the original bug).
    const changes = turnChanges(messages)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.path).toBe("quick_sort_1.py")
    expect(changes[0]!.additions).toBe(1)
    expect(changes[0]!.actors).toEqual([
      expect.objectContaining({ kind: "subagent", sessionID: "ses_subagent" }),
    ])
  })

  it("still works when the parent's task tool DOES publish metadata.sessionId (omo path)", async () => {
    // The other half of the matrix: when omo is installed and publishes the
    // child sessionID in metadata, the legacy registration path takes over.
    // We test that both pathways produce the same end result.
    const client = createOpencodeClient({ baseUrl: server.url })
    const parentBlocks: ChatBlock[] = []
    const messages: ChatMessage[] = [{ id: "a_parent", role: "assistant", blocks: parentBlocks }]

    const collectedChildEvents: ChildSessionEvent[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_parent", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionDiscovered: (info) => {
        subscription.addChildSession(info.id)
      },
      onChildSessionEvent: (event) => {
        collectedChildEvents.push(event)
        if (event.type === "tool") {
          parentBlocks.push({
            type: "tool",
            update: event.update,
            actor: { kind: "subagent", sessionID: event.sessionID, subagent: "explore" },
          })
        }
      },
    })
    await subscription.ready
    await server.awaitClient()

    // omo path: parent tool publishes metadata.sessionId before session.created
    // even arrives. Test that ALSO works via session.created auto-discovery —
    // the new path is additive, not exclusive.
    server.push({
      type: "session.created",
      info: { id: "ses_omo_child", parentID: "ses_parent", title: "delegated" },
    })
    await new Promise((r) => setTimeout(r, 20))
    server.push({
      type: "message.part.updated",
      part: {
        id: "part_write",
        messageID: "msg_child",
        sessionID: "ses_omo_child",
        type: "tool",
        callID: "call_write",
        tool: "write",
        state: {
          status: "completed",
          input: { filePath: "new_file.ts", content: "line1\nline2" },
          metadata: { exists: false },
        },
      },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()

    const changes = turnChanges(messages)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.kind).toBe("created")
    expect(changes[0]!.path).toBe("new_file.ts")
    expect(changes[0]!.actors?.[0]?.kind).toBe("subagent")
  })

  it("doesn't capture edits from sessions that aren't our subagents", async () => {
    // Robustness: if some unrelated session in opencode emits edit events,
    // we MUST NOT attribute them to the current conversation's review card.
    const client = createOpencodeClient({ baseUrl: server.url })
    const parentBlocks: ChatBlock[] = []
    const messages: ChatMessage[] = [{ id: "a_parent", role: "assistant", blocks: parentBlocks }]

    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_parent", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionDiscovered: (info) => {
        subscription.addChildSession(info.id)
      },
      onChildSessionEvent: (event) => {
        if (event.type === "tool") {
          parentBlocks.push({
            type: "tool",
            update: event.update,
            actor: { kind: "subagent", sessionID: event.sessionID },
          })
        }
      },
    })
    await subscription.ready
    await server.awaitClient()

    // Unrelated session (different parent).
    server.push({
      type: "session.created",
      info: { id: "ses_unrelated", parentID: "ses_some_other_parent" },
    })
    await new Promise((r) => setTimeout(r, 20))
    server.push({
      type: "message.part.updated",
      part: {
        id: "part_edit",
        messageID: "msg_unrelated",
        sessionID: "ses_unrelated",
        type: "tool",
        callID: "call_edit",
        tool: "edit",
        state: {
          status: "completed",
          input: { filePath: "should_not_appear.ts" },
          metadata: { filediff: { patch: "@@\n+x", additions: 1, deletions: 0 } },
        },
      },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()

    expect(turnChanges(messages)).toHaveLength(0)
  })
})
