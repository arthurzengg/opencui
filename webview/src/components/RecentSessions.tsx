import { useEffect, useMemo, useState } from "react"
import type { ConversationSummary, ExternalSessionSummary } from "../protocol"
import { mergeHistoryRows, formatUpdated } from "./StatusBar"

type Props = {
  conversations: ConversationSummary[]
  externalSessions: ExternalSessionSummary[]
  activeConversationID?: string
  onOpenConversation: (id: string) => void
  onImportSession?: (sessionID: string) => void
  onCreateConversation: () => void
  onRefreshSessions?: (search?: string) => void
}

/**
 * Home view shown when no conversation has messages yet: the composer stays
 * docked at the bottom (rendered by App) while this list fills the upper
 * area with the project's recent sessions, newest first. A prompt sent from
 * home lands in a fresh session via the host's lazy session-create path.
 */
export function RecentSessions({
  conversations,
  externalSessions,
  activeConversationID,
  onOpenConversation,
  onImportSession,
  onCreateConversation,
  onRefreshSessions,
}: Props) {
  const [query, setQuery] = useState("")

  useEffect(() => {
    onRefreshSessions?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rows = useMemo(() => {
    const merged = mergeHistoryRows(conversations, externalSessions ?? [])
    const withoutActive = activeConversationID
      ? merged.filter((row) =>
          row.kind === "conversation" ? row.conversation.id !== activeConversationID : true,
        )
      : merged
    const needle = query.trim().toLowerCase()
    if (!needle) return withoutActive
    return withoutActive.filter((row) => row.title.toLowerCase().includes(needle))
  }, [conversations, externalSessions, activeConversationID, query])

  return (
    <div className="home-recent" aria-label="Recent sessions">
      <div className="home-recent-header">
        <div className="home-recent-title">Recent sessions</div>
        <button type="button" className="history-new" onClick={onCreateConversation}>
          <span className="codicon codicon-add" aria-hidden="true" />
          <span className="history-new-text">New chat</span>
        </button>
      </div>
      <input
        className="history-search"
        type="text"
        placeholder="Search chats…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Search recent sessions"
      />
      <div className="home-recent-list" role="list">
        {rows.length === 0 && (
          <div className="history-empty">
            {query.trim() ? `No chats match “${query.trim()}”` : "No chats yet — type below to start a new one."}
          </div>
        )}
        {rows.map((row) => (
          <div className="history-item" key={row.key} role="listitem">
            <button
              className="history-open"
              onClick={() => {
                if (row.kind === "conversation") onOpenConversation(row.conversation.id)
                else onImportSession?.(row.session.id)
              }}
              title={
                row.kind === "session"
                  ? `${row.title} (opencode session from the TUI, web UI, or another client; opening saves it here)`
                  : row.title
              }
            >
              <span className="history-title">{row.title.trim() || "Untitled"}</span>
              <span className="history-date">{formatUpdated(row.updatedAt)}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
