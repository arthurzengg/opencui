import { OpenCode } from "@opencode/client/promise"
import type { ApiResult, BackendApi, PromptBody } from "../api"
import { mapAgents, mapCommands, mapMcpStatus, mapMessages, mapProviders, mapSession, mapSessionStatus } from "./map"
import { createEventTranslator, formAnswer, translateEvents } from "./events"

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
  // One translator for the adapter's lifetime: it remembers the asks that
  // replies answer.
  const translator = createEventTranslator()
  const unknown = <T>(what: string, id: string): Promise<ApiResult<T>> =>
    Promise.resolve({ error: new Error(`${what} ${id} was not seen on this connection`), status: 404 })
  const listSessions = async (filter: { parentID?: string | null; limit?: number; search?: string }) =>
    (await client.session.list({ directory, ...filter })).data

  // 1.x sends the model, agent, and variant with every prompt; 2.0 keeps them
  // on the session, so they are switched before the text goes in. The
  // injected context (#666) is a synthetic text part in 1.x and 2.0's own
  // synthetic message here, so the model still sees it and the transcript
  // does not. Files travel as URIs; the panel's attachments are data URLs.
  async function deliver(sessionID: string, body: PromptBody) {
    const selection = body as PromptBody & { variant?: string }
    if (selection.model) {
      await client.session.switchModel({ sessionID, model: { id: selection.model.modelID, providerID: selection.model.providerID, variant: selection.variant } })
    }
    if (selection.agent) await client.session.switchAgent({ sessionID, agent: selection.agent })
    const text: string[] = []
    const files: Array<{ uri: string; name?: string }> = []
    for (const part of body.parts) {
      if (part.type === "text" && part.synthetic) await client.session.synthetic({ sessionID, text: part.text })
      else if (part.type === "text") text.push(part.text)
      else if (part.type === "file") files.push({ uri: part.url, name: part.filename })
    }
    await client.session.prompt({ sessionID, text: text.join("\n\n"), files: files.length ? files : undefined })
  }
  return {
    directory,
    session: {
      create: () => call(async () => mapSession(await client.session.create(location), directory)),
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
      update: (id, body) =>
        call(async () => {
          await client.session.update({ sessionID: id, title: body.title })
          return mapSession(await client.session.get({ sessionID: id }), directory)
        }),
      delete: (id) => call(async () => (await client.session.remove({ sessionID: id }), true as const)),
      status: () => call(async () => mapSessionStatus(await listSessions({}))),
      children: (id) => call(async () => (await listSessions({ parentID: id })).map((s) => mapSession(s, directory))),
      // The sync prompt waits for the turn and answers with its last
      // assistant message, which is what the inline edit reads.
      prompt: (id, body) =>
        call(async () => {
          await deliver(id, body)
          await client.session.wait({ sessionID: id })
          const page = await client.message.list({ sessionID: id })
          const last = mapMessages(id, directory, page.data).filter((m) => m.info.role === "assistant").at(-1)
          if (!last) throw new Error("the turn produced no assistant message")
          return last as Awaited<ReturnType<BackendApi["session"]["prompt"]>> extends ApiResult<infer T> ? T : never
        }),
      promptAsync: (id, body) => call(async () => (await deliver(id, body), undefined as never)),
      command: () => unavailable("session.command"),
      abort: (id) => call(async () => (await client.session.interrupt({ sessionID: id }), true as const)),
      revert: () => unavailable("session.revert"),
      unrevert: () => unavailable("session.unrevert"),
      summarize: () => unavailable("session.summarize"),
      share: () => unavailable("session.share"),
      unshare: () => unavailable("session.unshare"),
      init: () => unavailable("session.init"),
      fork: () => unavailable("session.fork"),
    },
    permission: {
      reply: (requestID, reply) => {
        const sessionID = translator.sessionForPermission(requestID)
        if (!sessionID) return unknown("permission request", requestID)
        if (!reply) return Promise.resolve({ error: new Error("a permission reply needs a decision"), status: 400 })
        return call(async () => (await client.permission.reply({ sessionID, requestID, decision: reply }), true as const))
      },
    },
    question: {
      reply: (requestID, answers) => {
        const form = translator.form(requestID)
        if (!form) return unknown("form", requestID)
        return call(async () => (await client.session.form.reply({ sessionID: form.sessionID, formID: requestID, answer: formAnswer(form, answers ?? []) }), true as const))
      },
      reject: (requestID) => {
        const form = translator.form(requestID)
        if (!form) return unknown("form", requestID)
        return call(async () => (await client.session.form.cancel({ sessionID: form.sessionID, formID: requestID }), true as const))
      },
    },
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
    events: async (signal) => translateEvents(translator, client.event.subscribe({ signal })),
    health: () => call(async () => ({ healthy: true as const, version: (await client.server.info()).version })),
  }
}
