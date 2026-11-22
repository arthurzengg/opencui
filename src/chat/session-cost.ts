import type { Backend } from "../server"

// What a session has cost (#792). The server prices every assistant message;
// the work here is adding up the right ones: all of the session's own, not
// only the newest page, and those of the sessions its subagents ran in.

type CostMessage = { info?: { id?: string; role?: string; cost?: number } }
type ListedSession = { id: string; time?: { updated?: number } }

/** How many messages a refresh reads once a session's older ones are known. */
export const NEWEST_PAGE = 100

/**
 * What each message of a session cost, by message id. A refresh runs after
 * every step and reads the newest page only, so the older messages' costs are
 * kept here. A message the server has removed since stays as well: the turn
 * was billed.
 */
const ledgers = new Map<string, Map<string, number>>()

/**
 * What a subagent's session cost together with the sessions under it, and the
 * session's `updated` mark at the time: a session that has not run since is
 * not read again.
 */
const subtrees = new Map<string, { updated: number; cost: number }>()

/** Whether the session's older messages are known, so that the newest page is enough to read. */
export function knowsSession(sessionID: string): boolean {
  return ledgers.has(sessionID)
}

/**
 * The cost of a session: its own messages and the sessions of its subagents
 * and of theirs. `read` is what the caller just read of the session, the
 * whole log the first time and the newest page after that.
 */
export async function sessionCost(backend: Backend, sessionID: string, read: CostMessage[]): Promise<number> {
  const [own, subagents] = await Promise.all([ownCost(backend, sessionID, read), subagentCost(backend, sessionID)])
  return own + subagents
}

async function ownCost(backend: Backend, sessionID: string, read: CostMessage[]): Promise<number> {
  const ledger = ledgers.get(sessionID) ?? new Map<string, number>()
  // A page that reaches nothing already known means more than a page arrived
  // since the last refresh; the messages in between are read once.
  const gap = ledger.size > 0 && read.length > 0 && !read.some((m) => m.info?.id !== undefined && ledger.has(m.info.id))
  if (gap) record(ledger, await allMessages(backend, sessionID))
  record(ledger, read)
  ledgers.set(sessionID, ledger)
  return total(ledger.values())
}

async function subagentCost(backend: Backend, sessionID: string): Promise<number> {
  const res = await backend.api.session.children(sessionID)
  if (res.error) throw new Error(`session.children failed: ${JSON.stringify(res.error)}`)
  const children = (res.data ?? []) as ListedSession[]
  return total(await Promise.all(children.map((child) => subtreeCost(backend, child))))
}

async function subtreeCost(backend: Backend, session: ListedSession): Promise<number> {
  const updated = session.time?.updated ?? 0
  const known = subtrees.get(session.id)
  if (known && known.updated === updated) return known.cost
  const [messages, below] = await Promise.all([allMessages(backend, session.id), subagentCost(backend, session.id)])
  const ledger = new Map<string, number>()
  record(ledger, messages)
  const cost = total(ledger.values()) + below
  subtrees.set(session.id, { updated, cost })
  return cost
}

async function allMessages(backend: Backend, sessionID: string): Promise<CostMessage[]> {
  const res = await backend.api.session.messages(sessionID)
  if (res.error) throw new Error(`session.messages failed: ${JSON.stringify(res.error)}`)
  return (res.data ?? []) as CostMessage[]
}

function record(ledger: Map<string, number>, messages: CostMessage[]): void {
  for (const { info } of messages) {
    if (info?.role === "assistant" && info.id !== undefined && typeof info.cost === "number") ledger.set(info.id, info.cost)
  }
}

function total(costs: Iterable<number>): number {
  let sum = 0
  for (const cost of costs) sum += cost
  return sum
}
