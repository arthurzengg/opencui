import { describe, expect, it } from "vitest"
import type { AgentInfo, CommandInfo, McpServer, ModelInfo, ProviderInfo, SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import { mapAgents, mapCommands, mapMcpStatus, mapMessages, mapProviders, mapSession, mapSessionStatus } from "../../src/backend/v2/map"

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "ses_1",
  projectID: "proj_1",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 100, updated: 200 },
  title: "Hello",
  ...over,
})

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: "anthropic/claude-sonnet-5",
  modelID: "claude-sonnet-5",
  providerID: "anthropic",
  name: "Claude Sonnet 5",
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  variants: [{ id: "low" }, { id: "high" }],
  time: { released: Date.UTC(2026, 0, 15) },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 200_000, output: 64_000 },
  ...over,
})

describe("opencode 2.0 mappers (#693)", () => {
  it("maps a session to the listing shape the history reads", () => {
    const mapped = mapSession(session({ parentID: "ses_0" }), "/ws")
    expect(mapped).toMatchObject({ id: "ses_1", slug: "ses_1", parentID: "ses_0", title: "Hello", directory: "/ws", time: { created: 100, updated: 200 } })
  })

  it("derives idle from an outcome or an idle mark as new as the last update", () => {
    const statuses = mapSessionStatus([
      session({ id: "done", outcome: "succeeded" }),
      session({ id: "rested", time: { created: 1, updated: 50, idle: 50 } }),
      session({ id: "working", time: { created: 1, updated: 90, idle: 50 } }),
    ])
    expect(statuses).toEqual({ done: { type: "idle" }, rested: { type: "idle" }, working: { type: "busy" } })
  })

  it("maps user and assistant entries into messages with parts and skips bookkeeping entries", () => {
    const entries: SessionMessageInfo[] = [
      { type: "user", id: "u1", time: { created: 1 }, text: "explain this" },
      { type: "idle", id: "i1", time: { created: 2 } } as SessionMessageInfo,
      {
        type: "assistant",
        id: "a1",
        time: { created: 3, completed: 9 },
        agent: "build",
        model: { id: "claude-sonnet-5", providerID: "anthropic" },
        finish: "stop",
        cost: 0.12,
        tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 1, write: 2 } },
        content: [
          { type: "reasoning", text: "thinking", time: { created: 3, completed: 4 } },
          { type: "tool", id: "call_1", name: "read", time: { created: 4, ran: 5, completed: 6 }, state: { status: "completed", input: { filePath: "a.ts" }, content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }] } },
          { type: "tool", id: "call_2", name: "bash", time: { created: 6 }, state: { status: "error", input: { command: "x" }, error: { type: "ToolError", message: "exit 1" } } },
          { type: "tool", id: "call_3", name: "grep", time: { created: 7 }, state: { status: "streaming", input: "{\"pat" } },
          { type: "text", text: "Here is why." },
        ],
      },
    ]
    const items = mapMessages("ses_1", "/ws", entries)
    expect(items).toHaveLength(2)
    expect(items[0]!.info).toMatchObject({ id: "u1", role: "user", sessionID: "ses_1" })
    expect(items[0]!.parts).toEqual([expect.objectContaining({ type: "text", text: "explain this", messageID: "u1" })])
    const assistant = items[1]!
    expect(assistant.info).toMatchObject({ id: "a1", role: "assistant", modelID: "claude-sonnet-5", providerID: "anthropic", mode: "build", cost: 0.12, finish: "stop", tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 1, write: 2 } } })
    expect(assistant.parts.map((p) => p.type)).toEqual(["reasoning", "tool", "tool", "tool", "text"])
    expect(assistant.parts[1]).toMatchObject({ callID: "call_1", tool: "read", state: { status: "completed", output: "line 1\nline 2", title: "read", time: { start: 5, end: 6 } } })
    expect(assistant.parts[2]).toMatchObject({ callID: "call_2", state: { status: "error", error: "exit 1" } })
    expect(assistant.parts[3]).toMatchObject({ state: { status: "pending", raw: "{\"pat" } })
  })

  it("merges providers and models into the 1.x catalog, with variants and context limits", () => {
    const providers: ProviderInfo[] = [{ id: "anthropic", name: "Anthropic", activation: "enabled", package: "@ai-sdk/anthropic" }]
    const catalog = mapProviders(providers, [model(), model({ id: "openai/gpt-6", modelID: "gpt-6", providerID: "openai", name: "GPT-6", variants: [] })])
    expect(catalog.providers.map((p) => p.id)).toEqual(["anthropic", "openai"])
    const sonnet = catalog.providers[0]!.models["claude-sonnet-5"] as unknown as { variants: Record<string, unknown>; limit: { context: number }; capabilities: { attachment: boolean } }
    expect(Object.keys(sonnet.variants)).toEqual(["low", "high"])
    expect(sonnet.limit.context).toBe(200_000)
    expect(sonnet.capabilities.attachment).toBe(true)
    expect(catalog.providers[1]!.name).toBe("openai")
  })

  it("drops hidden agents and keeps mode, description, and model", () => {
    const agents: AgentInfo[] = [
      { id: "build", name: "build", mode: "primary", hidden: false, description: "Default", request: { settings: {}, headers: {} }, permissions: [], model: { id: "claude-sonnet-5", providerID: "anthropic" } },
      { id: "title", name: "title", mode: "primary", hidden: true, request: { settings: {}, headers: {} }, permissions: [] },
    ]
    expect(mapAgents(agents)).toEqual([expect.objectContaining({ name: "build", mode: "primary", description: "Default", model: { providerID: "anthropic", modelID: "claude-sonnet-5" } })])
  })

  it("maps commands without a template, since 2.0 carries none", () => {
    const commands: CommandInfo[] = [{ name: "review", description: "Review changes" }]
    expect(mapCommands(commands)).toEqual([{ name: "review", description: "Review changes" }])
  })

  it("maps every MCP status, naming the wait for a server still connecting", () => {
    const servers: McpServer[] = [
      { name: "a", status: { status: "connected" } },
      { name: "b", status: { status: "disabled" } },
      { name: "c", status: { status: "failed", error: "boom" } },
      { name: "d", status: { status: "needs_auth", error: "expired" } },
      { name: "e", status: { status: "pending" } },
    ]
    expect(mapMcpStatus(servers)).toEqual({
      a: { status: "connected" },
      b: { status: "disabled" },
      c: { status: "failed", error: "boom" },
      d: { status: "needs_auth" },
      e: { status: "failed", error: "still connecting" },
    })
  })
})
