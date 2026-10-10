import { OpenCode, type IntegrationInfo } from "@opencode/client/promise"
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

/** What 2.0.24 has no route for; the caller sees a failure, not a hang. */
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

  // 2.0 keeps credentials on integrations, which providers and MCP servers
  // point at; 1.x keyed everything by provider. The login methods the host
  // can drive are keys and OAuth, in the integration's order, so the method
  // index the picker hands back resolves against that same list.
  const integrations = async () => (await client.integration.list(location)).data
  const integrationFor = async (providerID: string): Promise<IntegrationInfo> => {
    const [providers, all] = await Promise.all([client.provider.list(location), integrations()])
    const id = providers.data.find((p) => p.id === providerID)?.integrationID ?? providerID
    const integration = all.find((i) => i.id === id)
    if (!integration) throw new Error(`no integration for provider ${providerID}`)
    return integration
  }
  const loginMethods = (integration: IntegrationInfo) =>
    integration.methods.flatMap((m) => (m.type === "oauth" || m.type === "key" ? [m] : []))
  const removeCredentials = async (integrationID: string) => {
    const entries = (await client.credential.list()).filter((c) => c.integrationID === integrationID)
    for (const entry of entries) await client.credential.remove({ credentialID: entry.id })
    return entries.length
  }
  const attempts = new Map<string, { integrationID: string; attemptID: string }>()
  type OAuthMethod = Extract<IntegrationInfo["methods"][number], { type: "oauth" }>
  // Providers and MCP servers sign in the same way: an OAuth attempt on
  // their integration, remembered under the caller's key until it ends.
  const startOAuth = async (key: string, integration: IntegrationInfo, method: OAuthMethod) => {
    const attempt = (await client.integration.oauth.connect({ ...location, integrationID: integration.id, methodID: method.id })).data
    attempts.set(key, { integrationID: integration.id, attemptID: attempt.attemptID })
    return { url: attempt.url, method: attempt.mode, instructions: attempt.instructions }
  }
  // With a code the attempt completes at once; without one the server
  // finishes it from the browser and the status is polled until then.
  const finishOAuth = async (key: string, code: string | undefined, signal?: AbortSignal) => {
    const attempt = attempts.get(key)
    if (!attempt) throw new Error(`no OAuth attempt in progress for ${key}`)
    const ref = { ...location, integrationID: attempt.integrationID, attemptID: attempt.attemptID }
    if (code) {
      await client.integration.oauth.complete({ ...ref, code })
      attempts.delete(key)
      return
    }
    for (;;) {
      if (signal?.aborted) {
        await client.integration.oauth.cancel(ref).catch(() => undefined)
        attempts.delete(key)
        throw new Error("cancelled")
      }
      const status = (await client.integration.oauth.status(ref)).data
      if (status.status === "complete") {
        attempts.delete(key)
        return
      }
      if (status.status === "failed" || status.status === "expired") {
        attempts.delete(key)
        throw new Error(status.status === "failed" ? status.message : "the sign-in attempt expired")
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  const mcpIntegration = async (name: string) => {
    const server = (await client.mcp.list(location)).data.find((s) => s.name === name)
    if (!server?.integrationID) throw new Error(`MCP server ${name} has no sign-in integration`)
    const integration = (await integrations()).find((i) => i.id === server.integrationID)
    if (!integration) throw new Error(`no integration ${server.integrationID} for MCP server ${name}`)
    return integration
  }

  // 1.x sends the model, agent, and variant with every prompt; 2.0 keeps them
  // on the session, so they are switched before the text goes in. The
  // injected context (#666) is a synthetic text part in 1.x; 2.0's synthetic
  // message starts a turn of its own (a live run showed a second execution
  // per prompt), so the context goes into the session's instructions under
  // one key, replaced per prompt and removed when a prompt carries none.
  // The model sees it in its instructions and the transcript does not.
  // Files travel as URIs; the panel's attachments are data URLs.
  const CONTEXT_KEY = "opencui.context"
  const contextual = new Set<string>()
  async function deliver(sessionID: string, body: PromptBody) {
    const selection = body as PromptBody & { variant?: string }
    if (selection.model) {
      await client.session.switchModel({ sessionID, model: { id: selection.model.modelID, providerID: selection.model.providerID, variant: selection.variant } })
    }
    if (selection.agent) await client.session.switchAgent({ sessionID, agent: selection.agent })
    const text: string[] = []
    const context: string[] = []
    const files: Array<{ uri: string; name?: string }> = []
    for (const part of body.parts) {
      if (part.type === "text" && part.synthetic) context.push(part.text)
      else if (part.type === "text") text.push(part.text)
      else if (part.type === "file") files.push({ uri: part.url, name: part.filename })
    }
    if (context.length) {
      await client.session.instructions.entry.put({ sessionID, key: CONTEXT_KEY, value: context.join("\n\n") })
      contextual.add(sessionID)
    } else if (contextual.delete(sessionID)) {
      await client.session.instructions.entry.remove({ sessionID, key: CONTEXT_KEY })
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
      // Busy is what the server calls active plus the executions this stream
      // saw start (the active route lags an execution's first events); the
      // listing's outcome and idle marks cover the rest. Sessions in neither
      // are left out, which the router reads as idle.
      status: () =>
        call(async () => {
          const [sessions, active] = await Promise.all([listSessions({}), client.session.active()])
          const derived = mapSessionStatus(sessions)
          const status: typeof derived = {}
          for (const [id, value] of Object.entries(derived)) if (value.type !== "busy") status[id] = value
          for (const id of [...Object.keys(active), ...translator.executing()]) status[id] = { type: "busy" }
          return status
        }),
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
      command: (id, body) =>
        call(async () => (await client.session.command({ sessionID: id, name: body.command, text: body.arguments }), undefined as never)),
      abort: (id) => call(async () => (await client.session.interrupt({ sessionID: id }), true as const)),
      // 1.x revert marks the session reverted to a message and unrevert
      // restores it; 2.0 stages a revert and clears it, with a separate
      // commit that the host never issues, so a reverted turn stays
      // recoverable the way /redo expects.
      revert: (id, body) =>
        call(async () => {
          await client.session.revert.stage({ sessionID: id, messageID: body.messageID })
          return mapSession(await client.session.get({ sessionID: id }), directory)
        }),
      unrevert: (id) =>
        call(async () => {
          await client.session.revert.clear({ sessionID: id })
          return mapSession(await client.session.get({ sessionID: id }), directory)
        }),
      summarize: (id) => call(async () => (await client.session.compact({ sessionID: id }), true as const)),
      share: () => unavailable("sharing a session"),
      unshare: () => unavailable("sharing a session"),
      // 2.0 keeps /init as a built-in command rather than a route of its own.
      init: (id) => call(async () => (await client.session.command({ sessionID: id, name: "init", text: "" }), true as const)),
      fork: (id, body) => call(async () => mapSession(await client.session.fork({ sessionID: id, before: body.messageID }), directory)),
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
          const [providers, models, all] = await Promise.all([client.provider.list(location), client.model.list(location), integrations()])
          return mapProviders(providers.data, models.data, all)
        }),
    },
    app: { agents: () => call(async () => mapAgents((await client.agent.list(location)).data)) },
    command: { list: () => call(async () => mapCommands((await client.command.list(location)).data)) },
    mcp: {
      status: () => call(async () => mapMcpStatus((await client.mcp.list(location)).data)),
      // 1.x says enabled, 2.0 says disabled; the rest of a config carries over.
      add: (body) =>
        call(async () => {
          const { enabled, ...config } = body.config as { enabled?: boolean } & Record<string, unknown>
          await client.mcp.add({ ...location, server: body.name, config: { ...config, disabled: enabled === false } as never })
          return mapMcpStatus((await client.mcp.list(location)).data)
        }),
      connect: (name) => call(async () => (await client.mcp.connect({ ...location, server: name }), true as const)),
      disconnect: (name) => call(async () => (await client.mcp.disconnect({ ...location, server: name }), true as const)),
      auth: {
        // An OAuth-capable remote server points at an integration and signs
        // in through that integration's attempt, which is what the 2.0 CLI's
        // own `mcp auth` runs. The server is reconnected afterwards; the
        // status read back says whether that took.
        authorize: (name) =>
          call(async () => {
            const integration = await mcpIntegration(name)
            const method = loginMethods(integration).find((m): m is OAuthMethod => m.type === "oauth")
            if (!method) throw new Error(`MCP server ${name} has no OAuth sign-in`)
            return startOAuth(`mcp:${name}`, integration, method)
          }),
        callback: (name, body, signal) =>
          call(async () => {
            await finishOAuth(`mcp:${name}`, body.code, signal)
            await client.mcp.connect({ ...location, server: name }).catch(() => undefined)
            const status = mapMcpStatus((await client.mcp.list(location)).data)[name]
            if (!status) throw new Error(`MCP server ${name} is not configured`)
            return status
          }),
        remove: (name) =>
          call(async () => {
            await removeCredentials((await mcpIntegration(name)).id)
            return { success: true as const }
          }),
      },
    },
    provider: {
      // The picker reads id and name off `all`; the legacy model shape it
      // declares is not filled in.
      list: () =>
        call(async () => {
          const [providers, all] = await Promise.all([client.provider.list(location), integrations()])
          const connected = providers.data
            .filter((p) => (all.find((i) => i.id === (p.integrationID ?? p.id))?.connections.length ?? 0) > 0)
            .map((p) => p.id)
          return { all: providers.data.map((p) => ({ id: p.id, name: p.name, env: [], models: {} })) as never, connected, default: {} }
        }),
      auth: () =>
        call(async () => {
          const [providers, all] = await Promise.all([client.provider.list(location), integrations()])
          const methods: Record<string, Array<{ type: "oauth" | "api"; label: string }>> = {}
          for (const p of providers.data) {
            const integration = all.find((i) => i.id === (p.integrationID ?? p.id))
            if (!integration) continue
            methods[p.id] = loginMethods(integration).map((m) => (m.type === "oauth" ? { type: "oauth", label: m.label } : { type: "api", label: m.label ?? "API key" }))
          }
          return methods
        }),
      oauth: {
        authorize: (providerID, body) =>
          call(async () => {
            const integration = await integrationFor(providerID)
            const method = loginMethods(integration)[body.method]
            if (!method || method.type !== "oauth") throw new Error(`login method ${body.method} of ${providerID} is not OAuth`)
            return startOAuth(`provider:${providerID}`, integration, method)
          }),
        callback: (providerID, body, signal) => call(async () => (await finishOAuth(`provider:${providerID}`, body.code, signal), true)),
      },
    },
    auth: {
      set: (providerID, body) =>
        call(async () => {
          if (body.type !== "api") throw new Error("only API keys can be stored from the panel on opencode 2.0")
          const integration = await integrationFor(providerID)
          await client.integration.connect.key({ ...location, integrationID: integration.id, key: body.key })
          return true
        }),
      remove: async (providerID) => {
        try {
          const integration = await integrationFor(providerID)
          const removed = await removeCredentials(integration.id)
          return removed > 0 ? { kind: "ok" } : { kind: "error", message: "no stored credential for this provider" }
        } catch (e) {
          return { kind: "error", message: (e as Error).message }
        }
      },
    },
    instance: { refresh: () => client.location.reload().then(() => true, () => false) },
    events: async (signal) => translateEvents(translator, client.event.subscribe({ signal })),
    health: () => call(async () => ({ healthy: true as const, version: (await client.server.info()).version })),
  }
}
