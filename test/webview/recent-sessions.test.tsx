import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RecentSessions } from "../../webview/src/components/RecentSessions"

afterEach(cleanup)

const conv = (id: string, title: string, updatedAt: number) => ({ id, title, updatedAt })
const ext = (id: string, title: string, updatedAt: number) => ({ id, title, updatedAt })

function baseProps(overrides = {}) {
  return {
    conversations: [],
    externalSessions: [],
    onOpenConversation: vi.fn(),
    onImportSession: vi.fn(),
    onCreateConversation: vi.fn(),
    onRefreshSessions: vi.fn(),
    ...overrides,
  }
}

describe("RecentSessions home view", () => {
  it("lists project conversations and external sessions newest-first", () => {
    render(
      <RecentSessions
        {...baseProps({
          conversations: [conv("c_old", "Old chat", 1000), conv("c_new", "New chat", 3000)],
          externalSessions: [ext("s_mid", "TUI session", 2000)],
        })}
      />,
    )
    const rows = document.querySelectorAll(".home-recent-list .history-title")
    expect([...rows].map((r) => r.textContent)).toEqual(["New chat", "TUI session", "Old chat"])
  })

  it("hides the active (empty home) conversation", () => {
    render(
      <RecentSessions
        {...baseProps({
          conversations: [conv("c_active", "New conversation", 5000), conv("c_other", "Real chat", 1000)],
          activeConversationID: "c_active",
        })}
      />,
    )
    const rows = document.querySelectorAll(".home-recent-list .history-title")
    expect([...rows].map((r) => r.textContent)).toEqual(["Real chat"])
  })

  it("opens a conversation on click and imports an external session", async () => {
    const onOpenConversation = vi.fn()
    const onImportSession = vi.fn()
    render(
      <RecentSessions
        {...baseProps({
          conversations: [conv("c1", "Saved", 2000)],
          externalSessions: [ext("s1", "External", 3000)],
          onOpenConversation,
          onImportSession,
        })}
      />,
    )
    await userEvent.click(screen.getByTitle("Saved"))
    expect(onOpenConversation).toHaveBeenCalledWith("c1")
    await userEvent.click(screen.getByTitle(/External \(opencode session/))
    expect(onImportSession).toHaveBeenCalledWith("s1")
  })

  it("creates a new chat from the header button and filters by search", async () => {
    const onCreateConversation = vi.fn()
    render(
      <RecentSessions
        {...baseProps({
          conversations: [conv("c1", "Alpha", 2000), conv("c2", "Beta", 1000)],
          onCreateConversation,
        })}
      />,
    )
    await userEvent.click(screen.getByText("New chat"))
    expect(onCreateConversation).toHaveBeenCalledTimes(1)
    await userEvent.type(screen.getByLabelText("Search recent sessions"), "alp")
    const rows = document.querySelectorAll(".home-recent-list .history-title")
    expect([...rows].map((r) => r.textContent)).toEqual(["Alpha"])
  })

  it("refreshes sessions on mount and shows the empty state", () => {
    const onRefreshSessions = vi.fn()
    render(<RecentSessions {...baseProps({ onRefreshSessions })} />)
    expect(onRefreshSessions).toHaveBeenCalledTimes(1)
    expect(document.querySelector(".home-recent-list .history-empty")?.textContent).toMatch(/No chats yet/)
  })
})
