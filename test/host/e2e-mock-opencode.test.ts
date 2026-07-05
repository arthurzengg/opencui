import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { startMockOpencode, type MockOpencodeServer } from "./mock-opencode-server"
import { subscribeSession } from "../../src/chat/stream"
import { sweepAbortTree, drainAbortTree } from "../../src/chat/abort-tree"

let server: MockOpencodeServer

beforeEach(async () => {
  server = await startMockOpencode()
})

afterEach(async () => {
  await server.close()
})

describe("E2E (mock opencode): SDK ↔ HTTP server", () => {
  it("session.create returns a session id", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const res = await client.session.create({ body: {} })
    expect(res.error).toBeUndefined()
    expect(res.data?.id).toBe("ses_test")
  })

  it("app.agents() returns the mocked agent list", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const res = await client.app.agents()
    expect(res.error).toBeUndefined()
    expect(res.data).toHaveLength(1)
    expect(res.data?.[0]?.name).toBe("default")
  })

  it("session.promptAsync records the request body server-side", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    await client.session.promptAsync({
      path: { id: "ses_test" },
      body: { parts: [{ type: "text", text: "hello" }] },
    })
    expect(server.prompts).toHaveLength(1)
    expect(server.prompts[0]!.sessionID).toBe("ses_test")
  })

  it("session.revert records the body server-side", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    await client.session.revert({
      path: { id: "ses_test" },
      body: { messageID: "msg_abc" },
    })
    expect(server.reverts).toHaveLength(1)
    expect((server.reverts[0]!.body as { messageID?: string })?.messageID).toBe("msg_abc")
  })

  it("session.unrevert (the /redo endpoint) round-trips", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const res = await client.session.unrevert({ path: { id: "ses_test" } })
    expect(res.error).toBeUndefined()
    expect(res.data?.id).toBe("ses_test")
    expect(server.unreverts).toEqual(["ses_test"])
  })

  it("session.fork returns a new session and records the source id", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const res = await client.session.fork({ path: { id: "ses_test" }, body: {} })
    expect(res.error).toBeUndefined()
    expect(res.data?.id).toBe("ses_forked")
    expect(res.data?.title).toBe("Forked session")
    expect(server.forks).toHaveLength(1)
    expect(server.forks[0]!.sessionID).toBe("ses_test")
  })

  it("session.children returns the configured direct children", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    server.setChildren("ses_parent", ["ses_child_a", "ses_child_b"])
    const res = await client.session.children({ path: { id: "ses_parent" } })
    expect(res.error).toBeUndefined()
    expect((res.data ?? []).map((s) => s.id)).toEqual(["ses_child_a", "ses_child_b"])
  })

  it("sweepAbortTree aborts the whole subtree, root first (Stop cancels every descendant)", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    // Tree: parent → [a, b]; a → [a1 (orchestrator grandchild)]. A parent-only
    // abort would miss a1 entirely — the bug this guards against.
    server.setChildren("ses_parent", ["ses_child_a", "ses_child_b"])
    server.setChildren("ses_child_a", ["ses_grand_a1"])

    const state = { aborted: new Set<string>(), isLive: () => true }
    const found = await sweepAbortTree(client, "ses_parent", [], state)

    expect(found).toBe(4)
    expect(server.aborts[0]).toBe("ses_parent") // root settles before any child
    expect(new Set(server.aborts)).toEqual(
      new Set(["ses_parent", "ses_child_a", "ses_child_b", "ses_grand_a1"]),
    )
  })

  it("a re-sweep over a fully swept tree is silent — post-Stop sessions are NOT hunted down", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    server.setChildren("ses_parent", ["ses_child_a"])

    const state = { aborted: new Set<string>(), isLive: () => true }
    expect(await sweepAbortTree(client, "ses_parent", [], state)).toBe(2)

    // A new session appears under the root right after Stop: opencode's own
    // title/summary/compaction children, or follow-up work that doesn't bump
    // the generation. The #317 visited/aborted split re-listed children of
    // aborted nodes and shot these down for the whole drain window — the
    // regression vs v1.4.3. Original semantics: traversal terminates at the
    // already-aborted root and the late session survives.
    server.setChildren("ses_parent", ["ses_child_a", "ses_post_stop"])
    expect(await sweepAbortTree(client, "ses_parent", [], state)).toBe(0)

    expect(server.aborts).toEqual(["ses_parent", "ses_child_a"])
  })

  it("a fresh generation re-aborts a session aborted by a previous Stop", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })

    // Stop 1 aborts the root; the user sends a new turn in the same session
    // and presses Stop again. ChatView.abortCurrent starts each generation
    // with a cleared aborted-set, so the root must be aborted again — the old
    // ChatView-lifetime set made every Stop after the first a no-op.
    const stop1 = { aborted: new Set<string>(), isLive: () => true }
    await sweepAbortTree(client, "ses_parent", [], stop1)
    const stop2 = { aborted: new Set<string>(), isLive: () => true }
    expect(await sweepAbortTree(client, "ses_parent", [], stop2)).toBe(1)

    expect(server.aborts).toEqual(["ses_parent", "ses_parent"])
  })

  it("drainAbortTree does NOT abort sessions dispatched after a completed sweep", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    server.setChildren("ses_parent", [])

    const state = { aborted: new Set<string>(), isLive: () => true }
    await sweepAbortTree(client, "ses_parent", [], state)
    expect(server.aborts).toEqual(["ses_parent"])

    // Stop is one volley: once the initial sweep covered the tree, the drain
    // must go quiet, not keep killing whatever spawns under the root next.
    server.setChildren("ses_parent", ["ses_late_dispatch"])
    await drainAbortTree(client, "ses_parent", state, { passes: 3, intervalMs: 5 })

    expect(server.aborts).toEqual(["ses_parent"])
  })

  it("sweepAbortTree abandons the walk when the generation is superseded", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    server.setChildren("ses_parent", ["ses_child_a", "ses_child_b"])

    // Generation dies as soon as the root abort lands (the user sent a new
    // turn); the children must NOT be aborted out from under the new turn.
    const state = { aborted: new Set<string>(), isLive: () => server.aborts.length === 0 }
    await sweepAbortTree(client, "ses_parent", [], state)

    expect(server.aborts).toEqual(["ses_parent"])
  })

  it("command.list returns the workspace's commands", async () => {
    server.setCommands([
      { name: "deploy", description: "Ship it", template: "Deploy $ARGUMENTS" },
      { name: "compact", description: "Compact", template: "Summarize the session" },
    ])
    const client = createOpencodeClient({ baseUrl: server.url })
    const res = await client.command.list({ query: { directory: "/tmp" } })
    expect(res.error).toBeUndefined()
    expect(res.data?.map((c) => c.name)).toEqual(["deploy", "compact"])
  })

  it("session.command records the command body with a string model", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    await client.session.command({
      path: { id: "ses_test" },
      query: { directory: "/tmp" },
      body: { command: "deploy", arguments: "prod", agent: "plan", model: "openai/gpt-5" },
    })
    expect(server.commandCalls).toHaveLength(1)
    const body = server.commandCalls[0]!.body as {
      command?: string
      arguments?: string
      agent?: string
      model?: unknown
    }
    expect(server.commandCalls[0]!.sessionID).toBe("ses_test")
    expect(body.command).toBe("deploy")
    expect(body.arguments).toBe("prod")
    expect(body.agent).toBe("plan")
    // Guards the #1 trap: session.command's model is a STRING, not the
    // { providerID, modelID } object that promptAsync takes.
    expect(typeof body.model).toBe("string")
    expect(body.model).toBe("openai/gpt-5")
  })

  it("session.command forwards a top-level variant the SDK type does not declare", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    // handleRunCommand sends `variant` as a top-level field (like promptAsync).
    // The SDK's SessionCommandData.body doesn't declare it, so it's cast on.
    // This guards that the SDK doesn't strip the unknown field before the wire —
    // the whole effort-on-/commands fix depends on it surviving serialization.
    const commandBody = { command: "deploy", arguments: "prod", model: "openai/gpt-5" }
    ;(commandBody as unknown as { variant?: string }).variant = "high"
    await client.session.command({
      path: { id: "ses_test" },
      query: { directory: "/tmp" },
      body: commandBody,
    })
    expect(server.commandCalls).toHaveLength(1)
    const recorded = server.commandCalls[0]!.body as { variant?: string }
    expect(recorded.variant).toBe("high")
  })

  it("session.summarize (the /compact endpoint) round-trips", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const res = await client.session.summarize({
      path: { id: "ses_test" },
      body: { providerID: "openai", modelID: "gpt-5" },
    })
    expect(res.error).toBeUndefined()
    expect(res.data).toBe(true)
  })

  it("session.share (the /share endpoint) returns a share url", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const res = await client.session.share({ path: { id: "ses_test" } })
    expect(res.error).toBeUndefined()
    expect(res.data?.share?.url).toBe("https://opencode.ai/s/abc123")
  })

  it("session.init (the /init endpoint) accepts a client-supplied messageID", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const res = await client.session.init({
      path: { id: "ses_test" },
      body: { providerID: "openai", modelID: "gpt-5", messageID: "msg_0123456789ABCDEFGHJKMNPQRS" },
    })
    expect(res.error).toBeUndefined()
    expect(res.data).toBe(true)
  })
})

describe("E2E (mock opencode): MCP management", () => {
  it("mcp.status returns the configured server map", async () => {
    server.setMcpStatus({
      github: { status: "connected" },
      linear: { status: "needs_auth" },
      postgres: { status: "failed", error: "ECONNREFUSED" },
    })
    const client = createOpencodeClient({ baseUrl: server.url })
    const res = await client.mcp.status({ query: { directory: "/tmp" } })
    expect(res.error).toBeUndefined()
    expect(res.data?.github?.status).toBe("connected")
    expect(res.data?.linear?.status).toBe("needs_auth")
    expect(res.data?.postgres?.status).toBe("failed")
  })

  it("mcp.add records a local config with a string[] command", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const res = await client.mcp.add({
      query: { directory: "/tmp" },
      body: { name: "gh", config: { type: "local", command: ["npx", "-y", "server-github"], enabled: true } },
    })
    expect(res.error).toBeUndefined()
    expect(res.data?.gh?.status).toBe("connected")
    expect(server.mcpAddCalls).toHaveLength(1)
    const body = server.mcpAddCalls[0]!.body as { name?: string; config?: { type?: string; command?: unknown } }
    expect(body.name).toBe("gh")
    expect(body.config?.type).toBe("local")
    expect(body.config?.command).toEqual(["npx", "-y", "server-github"])
  })

  it("mcp.add records a remote config with a url", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    await client.mcp.add({
      query: { directory: "/tmp" },
      body: { name: "remote1", config: { type: "remote", url: "https://example.com/mcp", enabled: true } },
    })
    const body = server.mcpAddCalls.at(-1)!.body as { config?: { type?: string; url?: string } }
    expect(body.config?.type).toBe("remote")
    expect(body.config?.url).toBe("https://example.com/mcp")
  })

  it("mcp.connect and mcp.disconnect return booleans and record the name", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const connected = await client.mcp.connect({ path: { name: "github" }, query: { directory: "/tmp" } })
    const disconnected = await client.mcp.disconnect({ path: { name: "github" }, query: { directory: "/tmp" } })
    expect(connected.data).toBe(true)
    expect(disconnected.data).toBe(true)
    expect(server.mcpConnectCalls).toEqual(["github"])
    expect(server.mcpDisconnectCalls).toEqual(["github"])
  })

  it("mcp.auth.authenticate returns a status and records the name", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const res = await client.mcp.auth.authenticate({ path: { name: "linear" }, query: { directory: "/tmp" } })
    expect(res.error).toBeUndefined()
    expect(res.data?.status).toBe("connected")
    expect(server.mcpAuthenticateCalls).toEqual(["linear"])
  })

  it("mcp.auth.remove reports success and records the name", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const res = await client.mcp.auth.remove({ path: { name: "linear" }, query: { directory: "/tmp" } })
    expect(res.error).toBeUndefined()
    expect(res.data?.success).toBe(true)
    expect(server.mcpAuthRemoveCalls).toEqual(["linear"])
  })
})

describe("E2E (mock opencode): subscribeSession streaming", () => {
  it("forwards onAssistantStart on first message.updated event", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const events: { mid: string }[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: (mid) => events.push({ mid }),
      onTextDelta: () => {},
    })
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "message.updated",
      info: { id: "msg_a", role: "assistant", sessionID: "ses_test" },
    })
    // Allow the SSE chunk to flow
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(events).toHaveLength(1)
    expect(events[0]?.mid).toBe("msg_a")
  })

  it("filters events for other sessions", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const events: { mid: string }[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: (mid) => events.push({ mid }),
      onTextDelta: () => {},
    })
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "message.updated",
      info: { id: "msg_other", role: "assistant", sessionID: "different_session" },
    })
    server.push({
      type: "message.updated",
      info: { id: "msg_ours", role: "assistant", sessionID: "ses_test" },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(events.map((e) => e.mid)).toEqual(["msg_ours"])
  })

  it("emits onAssistantEnd on a terminal finish reason", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const ends: { mid: string; finish?: string }[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onAssistantEnd: (mid, p) => ends.push({ mid, finish: p.finish }),
      onTextDelta: () => {},
    })
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "message.updated",
      info: { id: "msg_a", role: "assistant", sessionID: "ses_test" },
    })
    server.push({
      type: "message.updated",
      info: { id: "msg_a", role: "assistant", sessionID: "ses_test", finish: "stop" },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(ends).toHaveLength(1)
    expect(ends[0]?.finish).toBe("stop")
  })

  it("does NOT emit onAssistantEnd for non-terminal finish reasons (tool-calls)", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const ends: { mid: string }[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onAssistantEnd: (mid) => ends.push({ mid }),
      onTextDelta: () => {},
    })
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "message.updated",
      info: { id: "msg_a", role: "assistant", sessionID: "ses_test", finish: "tool-calls" },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(ends).toHaveLength(0)
  })

  it("forwards onUserMessage when a user message.updated arrives", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const userIDs: string[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onUserMessage: (mid) => userIDs.push(mid),
      onAssistantStart: () => {},
      onTextDelta: () => {},
    })
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "message.updated",
      info: { id: "usr_1", role: "user", sessionID: "ses_test" },
    })
    server.push({
      type: "message.updated",
      info: { id: "usr_1", role: "user", sessionID: "ses_test" }, // duplicate
    })
    server.push({
      type: "message.updated",
      info: { id: "usr_2", role: "user", sessionID: "ses_test" },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    // Each user message id reported once (deduped by seenUserMessages set)
    expect(userIDs).toEqual(["usr_1", "usr_2"])
  })

  it("aggregates streaming text deltas via message.part.updated", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const deltas: string[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onTextDelta: (_mid, delta) => deltas.push(delta),
    })
    await subscription.ready
    await server.awaitClient()
    // First chunk
    server.push({
      type: "message.part.updated",
      part: { id: "part_1", messageID: "msg_a", sessionID: "ses_test", type: "text", text: "Hello" },
    })
    // Second chunk extends the text
    server.push({
      type: "message.part.updated",
      part: { id: "part_1", messageID: "msg_a", sessionID: "ses_test", type: "text", text: "Hello, world" },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    // Stream emits two deltas: "Hello" then ", world"
    expect(deltas.join("")).toBe("Hello, world")
  })

  it("ignores part updates for user messages so plugin prompt rewrites are not echoed", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const starts: string[] = []
    const deltas: string[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onUserMessage: () => {},
      onAssistantStart: (mid) => starts.push(mid),
      onTextDelta: (_mid, delta) => deltas.push(delta),
    })
    await subscription.ready
    await server.awaitClient()
    // opencode saves the user message info before its parts
    server.push({
      type: "message.updated",
      info: { id: "usr_1", role: "user", sessionID: "ses_test" },
    })
    // A server-side plugin (e.g. oh-my-opencode) rewrites the user prompt,
    // which re-emits the user message's text part
    server.push({
      type: "message.part.updated",
      part: {
        id: "part_u",
        messageID: "usr_1",
        sessionID: "ses_test",
        type: "text",
        text: "[search-mode]\nMAXIMIZE SEARCH EFFORT\n\nWorkspace:\n- Name: opencui\n\nHello",
      },
    })
    // The real assistant reply still streams normally
    server.push({
      type: "message.updated",
      info: { id: "msg_a", role: "assistant", sessionID: "ses_test" },
    })
    server.push({
      type: "message.part.updated",
      part: { id: "part_1", messageID: "msg_a", sessionID: "ses_test", type: "text", text: "Hi" },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(starts).toEqual(["msg_a"])
    expect(deltas).toEqual(["Hi"])
  })

  it("ignores part deltas for user messages", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const starts: string[] = []
    const deltas: string[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onUserMessage: () => {},
      onAssistantStart: (mid) => starts.push(mid),
      onTextDelta: (_mid, delta) => deltas.push(delta),
    })
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "message.updated",
      info: { id: "usr_1", role: "user", sessionID: "ses_test" },
    })
    server.push({
      type: "message.part.delta",
      sessionID: "ses_test",
      messageID: "usr_1",
      partID: "part_u",
      field: "text",
      delta: "[analyze-mode]\nANALYSIS MODE",
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(starts).toEqual([])
    expect(deltas).toEqual([])
  })

  it("forwards tool updates with status running/completed", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const toolUpdates: { tool: string; status: string }[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onTool: (_mid, update) => toolUpdates.push({ tool: update.tool, status: update.status }),
    })
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "message.part.updated",
      part: {
        id: "part_t",
        messageID: "msg_a",
        sessionID: "ses_test",
        type: "tool",
        callID: "call_1",
        tool: "read",
        state: { status: "running", input: { filePath: "x.ts" } },
      },
    })
    server.push({
      type: "message.part.updated",
      part: {
        id: "part_t",
        messageID: "msg_a",
        sessionID: "ses_test",
        type: "tool",
        callID: "call_1",
        tool: "read",
        state: { status: "completed", input: { filePath: "x.ts" }, output: "ok" },
      },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(toolUpdates).toEqual([
      { tool: "read", status: "running" },
      { tool: "read", status: "completed" },
    ])
  })

  it("forwards onPatch when a patch part arrives", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const patches: { files: string[] }[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onPatch: (_mid, files) => patches.push({ files }),
    })
    await subscription.ready
    await server.awaitClient()
    server.push({
      type: "message.part.updated",
      part: {
        id: "part_p",
        messageID: "msg_a",
        sessionID: "ses_test",
        type: "patch",
        hash: "h1",
        files: ["A new.ts", "M existing.ts"],
        diff: "diff content",
      },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(patches).toHaveLength(1)
    expect(patches[0]?.files).toEqual(["A new.ts", "M existing.ts"])
  })
})

describe("E2E (mock opencode): child session routing", () => {
  it("does NOT call onChildSessionEvent for unregistered child sessions", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const events: { type: string; sessionID: string }[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionEvent: (e) => events.push({ type: e.type, sessionID: e.sessionID }),
    })
    await subscription.ready
    await server.awaitClient()
    server.push({ type: "session.idle", sessionID: "ses_unknown_child" })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(events).toEqual([])
  })

  it("routes session.idle on a REGISTERED child to onChildSessionEvent", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const events: { type: string; sessionID: string }[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionEvent: (e) => events.push({ type: e.type, sessionID: e.sessionID }),
    })
    await subscription.ready
    await server.awaitClient()
    subscription.addChildSession("ses_child_1")
    server.push({ type: "session.idle", sessionID: "ses_child_1" })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(events).toEqual([{ type: "idle", sessionID: "ses_child_1" }])
  })

  it("stops routing after removeChildSession", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const events: { type: string; sessionID: string }[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionEvent: (e) => events.push({ type: e.type, sessionID: e.sessionID }),
    })
    await subscription.ready
    await server.awaitClient()
    subscription.addChildSession("ses_child_1")
    subscription.removeChildSession("ses_child_1")
    server.push({ type: "session.idle", sessionID: "ses_child_1" })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(events).toEqual([])
  })

  it("treats message.part.updated for a registered child as a busy signal", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const events: { type: string; sessionID: string }[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionEvent: (e) => events.push({ type: e.type, sessionID: e.sessionID }),
    })
    await subscription.ready
    await server.awaitClient()
    subscription.addChildSession("ses_child_busy")
    server.push({
      type: "message.part.updated",
      part: {
        id: "p1",
        messageID: "m1",
        sessionID: "ses_child_busy",
        type: "text",
        text: "thinking",
      },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(events).toContainEqual({ type: "busy", sessionID: "ses_child_busy" })
  })

  it("forwards a terminal assistantEnd with usage from the child session", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const ends: { sessionID: string; usage?: { model?: string } }[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onChildSessionEvent: (e) => {
        if (e.type === "assistantEnd") ends.push({ sessionID: e.sessionID, usage: e.usage })
      },
    })
    await subscription.ready
    await server.awaitClient()
    subscription.addChildSession("ses_child_end")
    server.push({
      type: "message.updated",
      info: {
        id: "msg_child_a",
        role: "assistant",
        sessionID: "ses_child_end",
        finish: "stop",
        providerID: "github-copilot",
        modelID: "claude-opus-4.5",
        tokens: { input: 10, output: 20, reasoning: 5 },
      },
    })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    expect(ends).toHaveLength(1)
    expect(ends[0]?.sessionID).toBe("ses_child_end")
    expect(ends[0]?.usage?.model).toBe("github-copilot/claude-opus-4.5")
  })

  it("does NOT call the parent's onSessionIdle when a child session goes idle", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    let parentIdleCount = 0
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onTextDelta: () => {},
      onSessionIdle: () => {
        parentIdleCount += 1
      },
      onChildSessionEvent: () => {},
    })
    await subscription.ready
    await server.awaitClient()
    subscription.addChildSession("ses_child")
    server.push({ type: "session.idle", sessionID: "ses_child" })
    await new Promise((r) => setTimeout(r, 50))
    subscription.abort()
    // Critical isolation: a child going idle must not be confused with
    // the parent going idle, otherwise the busy spinner clears too early
    // when Hephaestus is mid-fanout.
    expect(parentIdleCount).toBe(0)
  })
})

describe("E2E (mock opencode): stream loss detection", () => {
  it("fires onStreamClosed when the server ends the SSE stream", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const closed: string[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onStreamClosed: (reason) => closed.push(reason),
    })
    await subscription.ready
    await server.awaitClient()
    await server.close()
    await new Promise((r) => setTimeout(r, 100))
    // Regression: a dead-but-truthy subscription used to block all
    // re-attach checks; the owner now learns the stream is gone.
    expect(closed).toHaveLength(1)
    subscription.abort()
  })

  it("does NOT fire onStreamClosed on deliberate abort", async () => {
    const client = createOpencodeClient({ baseUrl: server.url })
    const closed: string[] = []
    const subscription = subscribeSession({ url: server.url, client, directory: "/tmp" }, "ses_test", {
      onAssistantStart: () => {},
      onStreamClosed: (reason) => closed.push(reason),
    })
    await subscription.ready
    await server.awaitClient()
    subscription.abort()
    await new Promise((r) => setTimeout(r, 100))
    expect(closed).toHaveLength(0)
  })
})
