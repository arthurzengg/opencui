import { OpenCode } from "@opencode/client/promise"
import type { ApiResult, BackendApi } from "../api"

export type V2Client = ReturnType<typeof OpenCode.make>

/** HTTP status a ClientError carries in its detail, when it carries one. */
function statusOf(error: unknown): number {
  const detail = (error as { detail?: unknown })?.detail
  const match = typeof detail === "string" ? detail.match(/\b([1-5]\d\d)\b/) : null
  return match ? Number(match[1]) : 0
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
  return {
    directory,
    session: {
      create: () => unavailable("session.create"),
      list: () => unavailable("session.list"),
      messages: () => unavailable("session.messages"),
      update: () => unavailable("session.update"),
      delete: () => unavailable("session.delete"),
      status: () => unavailable("session.status"),
      children: () => unavailable("session.children"),
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
    config: { providers: () => unavailable("config.providers") },
    app: { agents: () => unavailable("app.agents") },
    command: { list: () => unavailable("command.list") },
    mcp: {
      status: () => unavailable("mcp.status"),
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
    events: async (signal) => client.event.subscribe({ signal }) as AsyncIterable<unknown>,
    health: () => call(async () => ({ healthy: true as const, version: (await client.server.info()).version })),
  }
}
