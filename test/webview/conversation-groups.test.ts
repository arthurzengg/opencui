import { describe, it, expect } from "vitest"
import {
  conversationDisplayTitle,
  conversationMatchesQuery,
  formatConversationUpdated,
  groupConversationsByTime,
} from "../../webview/src/conversation-groups"

const now = new Date("2026-05-28T15:00:00").getTime()
const startOfToday = (() => {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
})()
const DAY = 86_400_000
const conv = (id: string, updatedAt: number) => ({ id, title: id, updatedAt })

describe("groupConversationsByTime", () => {
  it("buckets by calendar recency, newest-first, dropping empty groups", () => {
    const groups = groupConversationsByTime(
      [
        conv("today", startOfToday + 3_600_000),
        conv("yesterday", startOfToday - 3_600_000),
        conv("week", startOfToday - 3 * DAY),
        conv("month", startOfToday - 10 * DAY),
        conv("old", startOfToday - 100 * DAY),
      ],
      now,
    )
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      "Previous 7 Days",
      "Previous 30 Days",
      "Older",
    ])
    expect(groups.map((g) => g.conversations.map((c) => c.id))).toEqual([
      ["today"],
      ["yesterday"],
      ["week"],
      ["month"],
      ["old"],
    ])
  })

  it("omits empty buckets and keeps newest-first within a bucket", () => {
    const groups = groupConversationsByTime(
      [
        conv("t1", startOfToday + 1000),
        conv("t2", startOfToday + 5000), // newer
        conv("old", startOfToday - 60 * DAY),
      ],
      now,
    )
    expect(groups.map((g) => g.label)).toEqual(["Today", "Older"])
    expect(groups[0]!.conversations.map((c) => c.id)).toEqual(["t2", "t1"])
  })

  it("returns [] for no conversations", () => {
    expect(groupConversationsByTime([], now)).toEqual([])
  })

  it("treats exactly local midnight as Today (>= boundary)", () => {
    const groups = groupConversationsByTime([conv("mid", startOfToday)], now)
    expect(groups[0]!.label).toBe("Today")
  })

  it("places the 7-day boundary in Previous 7 Days, one ms older in Previous 30 Days", () => {
    expect(groupConversationsByTime([conv("x", startOfToday - 7 * DAY)], now)[0]!.label).toBe(
      "Previous 7 Days",
    )
    expect(groupConversationsByTime([conv("x", startOfToday - 7 * DAY - 1)], now)[0]!.label).toBe(
      "Previous 30 Days",
    )
  })
})

describe("conversation display helpers", () => {
  it("falls back to Untitled for blank titles", () => {
    expect(conversationDisplayTitle({ id: "x", title: "  ", updatedAt: now })).toBe("Untitled")
  })

  it("formats updated timestamps for compact picker rows", () => {
    expect(formatConversationUpdated(now - 10_000, now)).toBe("just now")
    expect(formatConversationUpdated(now - 5 * 60_000, now)).toBe("5m ago")
    expect(formatConversationUpdated(now - 2 * 60 * 60_000, now)).toBe("2h ago")
  })

  it("matches by title or visible updated label", () => {
    const recent = { id: "x", title: "Refactor notes", updatedAt: Date.now() - 5 * 60_000 }
    expect(conversationMatchesQuery(recent, "refactor")).toBe(true)
    expect(conversationMatchesQuery(recent, "5m")).toBe(true)
    expect(conversationMatchesQuery(recent, "unrelated")).toBe(false)
  })
})
