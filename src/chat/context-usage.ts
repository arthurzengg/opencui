import type { Backend } from "../server"
import type { ContextUsage } from "../protocol"
import { NEWEST_PAGE, knowsSession, sessionCost } from "./session-cost"

type ContextUsageMessageInfo = {
  id?: string
  role?: string
  providerID?: string
  modelID?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

type ContextUsageMessage = { info?: ContextUsageMessageInfo }
type ContextUsageProvider = {
  id?: string
  models?: Record<string, { limit?: { context?: number } } | undefined>
}

// Provider metadata (model context limits) changes only when the user edits
// their opencode config, but readContextUsage runs after every turn. Cache it
// per backend with a short TTL so the indicator stops re-fetching it each turn.
type CachedProviders = { providers: ContextUsageProvider[]; at: number }
const providersCache = new Map<string, CachedProviders>()
const PROVIDERS_CACHE_MS = 5 * 60 * 1000

async function fetchProviders(backend: Backend): Promise<ContextUsageProvider[]> {
  const now = Date.now()
  const cached = providersCache.get(backend.url)
  if (cached && now - cached.at < PROVIDERS_CACHE_MS) return cached.providers
  const res = await backend.api.config.providers()
  if (res.error) {
    if (cached) return cached.providers
    throw new Error(`config.providers failed: ${JSON.stringify(res.error)}`)
  }
  const providers = (res.data as { providers?: ContextUsageProvider[] } | undefined)?.providers ?? []
  providersCache.set(backend.url, { providers, at: now })
  return providers
}

export async function readContextUsage(backend: Backend, sessionID: string): Promise<ContextUsage | undefined> {
  // The whole log the first time, so that the cost counts every message; the
  // newest page after that, since this runs after every step.
  const page = knowsSession(sessionID) ? { limit: NEWEST_PAGE } : undefined
  const [messagesRes, providers] = await Promise.all([
    backend.api.session.messages(sessionID, page),
    fetchProviders(backend),
  ])
  if (messagesRes.error) throw new Error(`session.messages failed: ${JSON.stringify(messagesRes.error)}`)

  const messages = (messagesRes.data ?? []) as ContextUsageMessage[]
  const usage = contextUsageFromMessages(messages, providers)
  if (!usage) return undefined
  const cost = await sessionCost(backend, sessionID, messages)
  return { ...usage, cost: cost > 0 ? cost : undefined }
}

export function contextUsageFromMessages(
  messages: ContextUsageMessage[],
  providers: ContextUsageProvider[],
): ContextUsage | undefined {
  const last = messages.findLast((item) =>
    item.info?.role === "assistant" && numberOrZero(item.info.tokens?.output) > 0
  )
  if (!last?.info?.tokens) return undefined

  const tokens = contextTokenCount(last.info.tokens)
  if (tokens <= 0) return undefined

  const providerID = last.info.providerID
  const modelID = last.info.modelID
  const limit = findContextLimit(providers, providerID, modelID)
  const cost = messages.reduce((sum, item) => {
    const info = item.info
    return info?.role === "assistant" && typeof info.cost === "number" ? sum + info.cost : sum
  }, 0)
  return {
    tokens,
    limit,
    percent: limit ? Math.round((tokens / limit) * 100) : undefined,
    model: providerID && modelID ? `${providerID}/${modelID}` : undefined,
    cost: cost > 0 ? cost : undefined,
  }
}

function contextTokenCount(tokens: NonNullable<ContextUsageMessageInfo["tokens"]>): number {
  return (
    numberOrZero(tokens.input) +
    numberOrZero(tokens.output) +
    numberOrZero(tokens.reasoning) +
    numberOrZero(tokens.cache?.read) +
    numberOrZero(tokens.cache?.write)
  )
}

function findContextLimit(
  providers: ContextUsageProvider[],
  providerID: string | undefined,
  modelID: string | undefined,
): number | undefined {
  if (!providerID || !modelID) return undefined
  const value = providers.find((provider) => provider.id === providerID)?.models?.[modelID]?.limit?.context
  return typeof value === "number" && value > 0 ? value : undefined
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
