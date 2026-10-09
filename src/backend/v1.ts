import { createOpencodeClient } from "@opencode-ai/sdk"
import { createOpencodeClient as createOpencodeClientV2 } from "@opencode-ai/sdk/v2"
import type { ApiResult, BackendApi } from "./api"
import { refreshInstance, removeProviderAuth } from "../provider/provider-format"

type SdkResult<T, E> = { data?: T; error?: E; response?: { status: number } }

/** The SDK answers with { data, error, request, response }; keep what the host reads. */
function result<T, E>(res: SdkResult<T, E>): ApiResult<T, E> {
  const status = res.response?.status ?? 0
  return res.error !== undefined
    ? { error: res.error, status }
    : { data: res.data as T, status }
}

const call = async <T, E>(p: Promise<SdkResult<T, E>>): Promise<ApiResult<T, E>> => result(await p)

/**
 * opencode 1.x. The v1 client is a frozen snapshot of the API and never
 * gained the permission and question reply routes, session listing with
 * filters, or the health route; those go through the v2 client (#609).
 */
export function createV1Api(url: string, directory: string): BackendApi {
  const client = createOpencodeClient({ baseUrl: url, directory })
  const clientV2 = createOpencodeClientV2({ baseUrl: url, directory })
  const query = { directory }
  return {
    directory,
    session: {
      create: () => call(client.session.create({ body: {} })),
      list: (options) => call(clientV2.session.list({ directory, ...options })),
      messages: (id, options) => call(client.session.messages({ path: { id }, query: { ...query, ...options } })),
      update: (id, body) => call(client.session.update({ path: { id }, query, body })),
      delete: (id) => call(client.session.delete({ path: { id }, query })),
      status: () => call(client.session.status({ query })),
      children: (id) => call(client.session.children({ path: { id }, query })),
      prompt: (id, body) => call(client.session.prompt({ path: { id }, query, body })),
      promptAsync: (id, body) => call(client.session.promptAsync({ path: { id }, query, body })),
      command: (id, body) => call(client.session.command({ path: { id }, query, body })),
      abort: (id) => call(client.session.abort({ path: { id }, query })),
      revert: (id, body) => call(client.session.revert({ path: { id }, query, body })),
      unrevert: (id) => call(client.session.unrevert({ path: { id }, query })),
      summarize: (id, body) => call(client.session.summarize({ path: { id }, query, body })),
      share: (id) => call(client.session.share({ path: { id }, query })),
      unshare: (id) => call(client.session.unshare({ path: { id }, query })),
      init: (id, body) => call(client.session.init({ path: { id }, query, body })),
      fork: (id, body) => call(client.session.fork({ path: { id }, query, body })),
    },
    permission: {
      reply: (requestID, reply) => call(clientV2.permission.reply({ requestID, reply, directory })),
    },
    question: {
      reply: (requestID, answers) => call(clientV2.question.reply({ requestID, answers, directory })),
      reject: (requestID) => call(clientV2.question.reject({ requestID, directory })),
    },
    config: {
      providers: () => call(client.config.providers({ query })),
    },
    app: {
      agents: () => call(client.app.agents({ query })),
    },
    command: {
      list: () => call(client.command.list({ query })),
    },
    mcp: {
      status: () => call(client.mcp.status({ query })),
      add: (body) => call(client.mcp.add({ query, body })),
      connect: (name) => call(client.mcp.connect({ path: { name }, query })),
      disconnect: (name) => call(client.mcp.disconnect({ path: { name }, query })),
      auth: {
        // 1.x runs the whole sign-in server-side, browser included: there is
        // nothing to open, and the one blocking call is the callback.
        authorize: () => Promise.resolve({ data: { url: "", method: "auto" as const, instructions: "" }, status: 200 }),
        callback: (name, _body, signal) => call(client.mcp.auth.authenticate({ path: { name }, query, signal })),
        remove: (name) => call(client.mcp.auth.remove({ path: { name }, query })),
      },
    },
    provider: {
      list: () => call(client.provider.list({ query })),
      auth: () => call(client.provider.auth({ query })),
      oauth: {
        authorize: (providerID, body) => call(client.provider.oauth.authorize({ path: { id: providerID }, query, body })),
        callback: (providerID, body, signal) =>
          call(client.provider.oauth.callback({ path: { id: providerID }, query, body, signal })),
      },
    },
    auth: {
      set: (providerID, body) => call(client.auth.set({ path: { id: providerID }, query, body })),
      // No published SDK exposes these two routes; they stay raw fetches.
      remove: (providerID) => removeProviderAuth(url, providerID),
    },
    instance: {
      refresh: () => refreshInstance(url, directory),
    },
    events: async (signal) => {
      const sse = await client.global.event({ signal })
      return sse.stream as AsyncIterable<unknown>
    },
    health: () => call(clientV2.global.health()),
  }
}
