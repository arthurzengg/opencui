import type {
  Agent,
  AssistantMessage,
  McpStatus,
  Message,
  Model,
  Part,
  Provider,
  Session,
  SessionStatus,
  ToolState,
  UserMessage,
} from "@opencode-ai/sdk"
import type { Session as SessionListed } from "@opencode-ai/sdk/v2"
import type { CommandEntry } from "../api"
import type {
  AgentInfo,
  CommandInfo,
  McpServer,
  ModelInfo,
  ProviderInfo,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionMessageUser,
} from "@opencode/client/promise"

/**
 * opencode 2.0 payloads, shaped as the 1.x payloads the host reads (#693).
 * Each mapper fills what the host consumes and gives the rest the
 * 1.x-required defaults; fields 2.0 no longer has stay empty rather than
 * invented.
 */

/** The listing route answers with the v2 client's Session, a superset of the 1.x one (slug). */
export function mapSession(session: SessionInfo, directory: string): Session & SessionListed {
  return {
    id: session.id,
    slug: session.id,
    projectID: session.projectID,
    directory,
    parentID: session.parentID,
    title: session.title ?? "",
    version: "2",
    time: { created: session.time.created, updated: session.time.updated },
  }
}

/**
 * 2.0 has no status route. A session is idle once it has an outcome or an
 * idle mark as new as its last update; one with neither (a fresh session,
 * or one updated since its last idle) is busy only as far as the listing
 * can tell, and the adapter overrides that with what the stream saw.
 */
export function mapSessionStatus(sessions: SessionInfo[]): Record<string, SessionStatus> {
  const out: Record<string, SessionStatus> = {}
  for (const s of sessions) {
    const idle = s.outcome !== undefined || (s.time.idle !== undefined && s.time.idle >= s.time.updated)
    out[s.id] = idle ? { type: "idle" } : { type: "busy" }
  }
  return out
}

export type MessageItem = { info: Message; parts: Part[] }

/** Only the user and assistant entries of 2.0's message log become messages; its bookkeeping entries (model selected, idle, ...) carry nothing the transcript shows. */
export function mapMessages(sessionID: string, directory: string, entries: SessionMessageInfo[]): MessageItem[] {
  const items: MessageItem[] = []
  for (const entry of entries) {
    if (entry.type === "user") items.push(mapUser(sessionID, entry))
    else if (entry.type === "assistant") items.push(mapAssistant(sessionID, directory, entry))
  }
  return items
}

function mapUser(sessionID: string, entry: SessionMessageUser): MessageItem {
  const info: UserMessage = {
    id: entry.id,
    sessionID,
    role: "user",
    time: { created: entry.time.created },
    agent: "",
    model: { providerID: "", modelID: "" },
  }
  return { info, parts: [{ id: `${entry.id}:text`, sessionID, messageID: entry.id, type: "text", text: entry.text }] }
}

function mapAssistant(sessionID: string, directory: string, entry: SessionMessageAssistant): MessageItem {
  const info: AssistantMessage = {
    id: entry.id,
    sessionID,
    role: "assistant",
    time: { created: entry.time.created, completed: entry.time.completed },
    parentID: "",
    modelID: entry.model.id,
    providerID: entry.model.providerID,
    mode: entry.agent,
    path: { cwd: directory, root: directory },
    cost: entry.cost ?? 0,
    tokens: entry.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: entry.finish,
    error: entry.error ? { name: "UnknownError", data: { message: entry.error.message } } : undefined,
  }
  const parts: Part[] = entry.content.map((content, index) => {
    const id = `${entry.id}:${index}`
    if (content.type === "text") return { id, sessionID, messageID: entry.id, type: "text", text: content.text }
    if (content.type === "reasoning") {
      return { id, sessionID, messageID: entry.id, type: "reasoning", text: content.text, time: { start: content.time?.created ?? entry.time.created, end: content.time?.completed } }
    }
    return { id, sessionID, messageID: entry.id, type: "tool", callID: content.id, tool: content.name, state: mapToolState(content) }
  })
  return { info, parts }
}

function mapToolState(tool: SessionMessageAssistantTool): ToolState {
  const start = tool.time.ran ?? tool.time.created
  const end = tool.time.completed ?? start
  const state = tool.state
  if (state.status === "completed") {
    const output = state.content.map((c) => (c.type === "text" ? c.text : c.uri)).join("\n")
    return { status: "completed", input: state.input, output, title: tool.name, metadata: state.metadata ?? {}, time: { start, end } }
  }
  if (state.status === "error") {
    return { status: "error", input: state.input, error: state.error.message, metadata: state.metadata, time: { start, end } }
  }
  if (state.status === "running") return { status: "running", input: state.input, metadata: state.metadata, time: { start } }
  return { status: "pending", input: {}, raw: state.input }
}

/** The 1.x Model never carried variants; the picker reads them off the raw payload. */
type ModelWithVariants = Model & { variants: Record<string, Record<string, never>> }

/** The picker reads `models[id].variants` and context-usage reads `models[id].limit.context`. */
export function mapProviders(providers: ProviderInfo[], models: ModelInfo[]): { providers: Provider[]; default: Record<string, string> } {
  const byProvider = new Map<string, Provider>()
  const providerFor = (id: string, name = id): Provider => {
    const existing = byProvider.get(id)
    if (existing) return existing
    const created: Provider = { id, name, source: "config", env: [], options: {}, models: {} }
    byProvider.set(id, created)
    return created
  }
  for (const p of providers) providerFor(p.id, p.name)
  for (const m of models) {
    const kinds = (list: string[]) => ({
      text: list.includes("text"),
      audio: list.includes("audio"),
      image: list.includes("image"),
      video: list.includes("video"),
      pdf: list.includes("pdf"),
    })
    const model: ModelWithVariants = {
      id: m.modelID,
      providerID: m.providerID,
      api: { id: m.id, url: "", npm: m.package ?? "" },
      name: m.name,
      capabilities: {
        temperature: true,
        reasoning: m.variants.length > 0,
        attachment: m.capabilities.input.some((kind) => kind !== "text"),
        toolcall: m.capabilities.tools,
        input: kinds(m.capabilities.input),
        output: kinds(m.capabilities.output),
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: m.limit.context, output: m.limit.output },
      status: m.status,
      options: {},
      headers: {},
      variants: Object.fromEntries(m.variants.map((v) => [v.id, {}])),
    }
    providerFor(m.providerID).models[m.modelID] = model
  }
  return { providers: [...byProvider.values()], default: {} }
}

export function mapAgents(agents: AgentInfo[]): Agent[] {
  return agents
    .filter((a) => !a.hidden)
    .map((a) => ({
      name: a.name,
      description: a.description,
      mode: a.mode,
      builtIn: false,
      permission: {} as Agent["permission"],
      model: a.model ? { providerID: a.model.providerID, modelID: a.model.id } : undefined,
      tools: {},
      options: {},
    }))
}

/** 2.0 commands carry no template, so none is known to take arguments. */
export function mapCommands(commands: CommandInfo[]): CommandEntry[] {
  return commands.map((c) => ({ name: c.name, description: c.description }))
}

/** 2.0's "pending" (still connecting) has no 1.x counterpart; it shows as a failure that names the wait. */
export function mapMcpStatus(servers: McpServer[]): Record<string, McpStatus> {
  const out: Record<string, McpStatus> = {}
  for (const s of servers) {
    const status = s.status
    out[s.name] =
      status.status === "connected" ? { status: "connected" }
      : status.status === "disabled" ? { status: "disabled" }
      : status.status === "failed" ? { status: "failed", error: status.error }
      : status.status === "needs_auth" ? { status: "needs_auth" }
      : { status: "failed", error: "still connecting" }
  }
  return out
}
