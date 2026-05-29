import type { ConversationSummary } from "./protocol"

export type ConversationGroup = { label: string; conversations: ConversationSummary[] }

const DAY = 86_400_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * Bucket conversations into recency groups for the "Past Chats" picker, newest
 * first within each group; empty groups are dropped. `now` is injected so the
 * logic is deterministic in tests. Day boundaries use local midnight, so
 * "Today"/"Yesterday" track the calendar rather than a rolling 24h window.
 */
export function groupConversationsByTime(
  conversations: ConversationSummary[],
  now: number,
): ConversationGroup[] {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const startOfToday = midnight.getTime()
  const buckets = [
    { label: "Today", min: startOfToday },
    { label: "Yesterday", min: startOfToday - DAY },
    { label: "Previous 7 Days", min: startOfToday - 7 * DAY },
    { label: "Previous 30 Days", min: startOfToday - 30 * DAY },
    { label: "Older", min: -Infinity },
  ].map((b) => ({ ...b, conversations: [] as ConversationSummary[] }))

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const conv of sorted) {
    // Buckets run newest-first, so the first whose floor the conversation clears
    // is the tightest fit.
    const bucket = buckets.find((b) => conv.updatedAt >= b.min)!
    bucket.conversations.push(conv)
  }

  return buckets
    .filter((b) => b.conversations.length > 0)
    .map(({ label, conversations }) => ({ label, conversations }))
}

export function conversationDisplayTitle(conversation: ConversationSummary): string {
  return conversation.title.trim() || "Untitled"
}

export function formatConversationUpdated(updatedAt: number, now: number = Date.now()): string {
  const date = new Date(updatedAt)
  const diff = Math.max(0, now - updatedAt)

  if (diff < 30 * 1000) return "just now"
  if (diff < HOUR) return `${Math.max(1, Math.floor(diff / MINUTE))}m ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`

  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const yesterday = new Date(startOfToday.getTime() - DAY)
  if (date >= yesterday && date < startOfToday) return "yesterday"

  const weekStart = new Date(startOfToday)
  weekStart.setDate(startOfToday.getDate() - 6)
  if (date >= weekStart) return date.toLocaleDateString([], { weekday: "short" })

  if (date.getFullYear() === startOfToday.getFullYear()) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" })
  }
  return date.toLocaleDateString([], { month: "short", year: "numeric" })
}

export function conversationMatchesQuery(conversation: ConversationSummary, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    conversationDisplayTitle(conversation),
    formatConversationUpdated(conversation.updatedAt),
  ].join(" ").toLowerCase()
  return haystack.includes(q)
}
