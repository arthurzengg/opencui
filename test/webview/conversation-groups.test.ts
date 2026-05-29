import { describe, it, expect } from "vitest"
import { groupConversationsByTime } from "../../webview/src/conversation-groups"

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
