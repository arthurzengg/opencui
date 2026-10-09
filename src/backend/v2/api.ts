import { OpenCode } from "@opencode/client/promise"
import type { ApiResult, BackendApi } from "../api"
import { mapAgents, mapCommands, mapMcpStatus, mapMessages, mapProviders, mapSession, mapSessionStatus } from "./map"
import { translateEvents } from "./events"

export type V2Client = ReturnType<typeof OpenCode.make>

/**
 * A status the endpoint declares comes back as the decoded error body, with
 * no number attached; only an undeclared one arrives as a ClientError that
 * carries it. So this is best effort, and 0 means "a failure, status unknown".
 */
function statusOf(error: unknown): number {
  const { cause, detail } = (error ?? {}) as { cause?: { status?: unknown }; detail?: unknown }
  if (typeof cause?.status === "number") return cause.status
  return typeof detail === "string" && /^[1-5]\d\d$/.test(detail) ? Number(detail) : 0
}

async function call<T>(run: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return { data: await run(), status: 200 }
  } catch (error) {
    return { error, status: statusOf(error) }
  }
}

/** The steps after #693 fill these in; until then the caller sees a failure, not a hang. */
function unavailable<T>(operation: string): Promise<ApiResult<T>> {
  return Promise.resolve({ error: new Error(`${operation} is not available on opencode 2.0 yet (#684)`), status: 501 })
}

/**
 * opencode 2.0 (#684). The server wants HTTP Basic auth with the password
 * it was started with, and scopes requests by a location rather than a
 * per-request directory. The promise client throws on any non-2xx, which
 * `call` folds back into the { data, error, status } shape the host reads.
 */
export function createV2Api(options: { url: string; directory: string; password: string }): BackendApi {
  const { url, directory, password } = options
  const client = OpenCode.make({
    baseUrl: url,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  })
  const location = { location: { directory } }
  const listSessions = async (filter: { parentID?: string | null; limit?: number; search?: string }) =>
    (await client.session.list({ directory, ...filter })).data
  return {
    directory,
    session: {
      create: () => unavailable("session.create"),
      list: (options) =>
        call(async () => {
          const rows = await listSessions({
            parentID: options?.roots ? null : undefined,
            limit: options?.limit,
            search: options?.search,
          })
          return rows.map((s) => mapSession(s, directory))
        }),
      messages: (id, options) =>
        call(async () => {
          const page = await client.message.list({ sessionID: id, limit: options?.limit })
          return mapMessages(id, directory, page.data)
        }),
      update: () => unavailable("session.update"),
      delete: () => unavailable("session.delete"),
      status: () => call(async () => mapSessionStatus(await listSessions({}))),
      children: (id) => call(async () => (await listSessions({ parentID: id })).map((s) => mapSession(s, directory))),
      prompt: () => unavailable("session.prompt"),
      promptAsync: () => unavailable("session.promptAsync"),
      command: () => unavailable("session.command"),
      abort: () => unavailable("session.abort"),
      revert: () => unavailable("session.revert"),
      unrevert: () => unavailable("session.unrevert"),
      summarize: () => unavailable("session.summarize"),
      share: () => unavailable("session.share"),
      unshare: () => unavailable("session.unshare"),
      init: () => unavailable("session.init"),
      fork: () => unavailable("session.fork"),
    },
    permission: { reply: () => unavailable("permission.reply") },
    question: { reply: () => unavailable("question.reply"), reject: () => unavailable("question.reject") },
    config: {
      providers: () =>
        call(async () => {
          const [providers, models] = await Promise.all([client.provider.list(location), client.model.list(location)])
          return mapProviders(providers.data, models.data)
        }),
    },
    app: { agents: () => call(async () => mapAgents((await client.agent.list(location)).data)) },
    command: { list: () => call(async () => mapCommands((await client.command.list(location)).data)) },
    mcp: {
      status: () => call(async () => mapMcpStatus((await client.mcp.list(location)).data)),
      add: () => unavailable("mcp.add"),
      connect: () => unavailable("mcp.connect"),
      disconnect: () => unavailable("mcp.disconnect"),
      auth: { authenticate: () => unavailable("mcp.auth.authenticate"), remove: () => unavailable("mcp.auth.remove") },
    },
    provider: {
      list: () => unavailable("provider.list"),
      auth: () => unavailable("provider.auth"),
      oauth: { authorize: () => unavailable("provider.oauth.authorize"), callback: () => unavailable("provider.oauth.callback") },
    },
    auth: {
      set: () => unavailable("auth.set"),
      remove: () => Promise.resolve({ kind: "unsupported" as const }),
    },
    instance: { refresh: () => Promise.resolve(false) },
    events: async (signal) => translateEvents(client.event.subscribe({ signal })),
    health: () => call(async () => ({ healthy: true as const, version: (await client.server.info()).version })),
  }
}
