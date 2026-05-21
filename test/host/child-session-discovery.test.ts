import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { startMockOpencode, type MockOpencodeServer } from "./mock-opencode-server"
import { subscribeSession, type ChildSessionInfo } from "../../src/chat/stream"

let server: MockOpencodeServer

beforeEach(async () => {
  server = await startMockOpencode()
})

afterEach(async () => {
  await server.close()
})

describe("subscribeSession: child-session auto-discovery via session.created", () => {
  it("fires onChildSessionDiscovered for session.created with our parent ID", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const discovered: ChildSessionInfo[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_parent", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionDiscovered: (info) => discovered.push(info),
    })
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "session.created",
      // @ts-expect-error - mock pass-through allows arbitrary payload shapes
      info: { id: "ses_child_1", parentID: "ses_parent", title: "delegated work" },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(discovered).toEqual([
      { id: "ses_child_1", parentID: "ses_parent", title: "delegated work" },
    ])
  })

  it("ignores session.created events for unrelated parents", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const discovered: ChildSessionInfo[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_parent", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionDiscovered: (info) => discovered.push(info),
    })
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "session.created",
      // @ts-expect-error - mock pass-through allows arbitrary payload shapes
      info: { id: "ses_other_child", parentID: "ses_other_parent" },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(discovered).toEqual([])
  })

  it("fires for session.updated when parentID becomes known", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const discovered: ChildSessionInfo[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_parent", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionDiscovered: (info) => discovered.push(info),
    })
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "session.updated",
      // @ts-expect-error - mock pass-through allows arbitrary payload shapes
      info: { id: "ses_late_child", parentID: "ses_parent" },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(discovered.map((d) => d.id)).toEqual(["ses_late_child"])
  })

  it("ignores session.created events that lack a parentID", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const discovered: ChildSessionInfo[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_parent", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionDiscovered: (info) => discovered.push(info),
    })
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "session.created",
      // @ts-expect-error - mock pass-through allows arbitrary payload shapes
      info: { id: "ses_root", title: "no parent" },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(discovered).toEqual([])
  })
})
