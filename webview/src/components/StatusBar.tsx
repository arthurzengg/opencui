import { useEffect, useRef, useState } from "react"
import type { ConversationSummary, Selection } from "../protocol"

type Props = {
  connected: boolean
  error?: string
  selection: Selection
  conversations: ConversationSummary[]
  activeConversationID?: string
  onSelectAgent: () => void
  onSelectModel: () => void
  onCreateConversation: () => void
  onOpenConversation: (id: string) => void
  onRenameConversation: (id: string, title: string) => void
  onDeleteConversation: (id: string) => void
}

export function StatusBar({
  connected,
  error,
  selection,
  conversations,
  activeConversationID,
  onSelectAgent,
  onSelectModel,
  onCreateConversation,
  onOpenConversation,
  onRenameConversation,
  onDeleteConversation,
}: Props) {
  const agent = selection.agent ?? "default"
  const model = selection.model ?? "default"
  const active = conversations.find((c) => c.id === activeConversationID)

  return (
    <div className="statusbar">
      <span className={`dot ${connected ? "ok" : error ? "err" : "warn"}`} />
      <span className="status-text">
        {error ? `error · ${error}` : connected ? "connected" : "connecting…"}
      </span>
      <div className="spacer" />
      <button className="chip" onClick={onSelectAgent} title={`Agent: ${agent}`}>
        <span className="chip-icon">Agent</span>
        <span className="chip-text">{agent}</span>
      </button>
      <button className="chip" onClick={onSelectModel} title={`Model: ${model}`}>
        <span className="chip-icon">Model</span>
        <span className="chip-text">{model}</span>
      </button>
      <ChatHistoryMenu
        conversations={conversations}
        activeID={activeConversationID}
        activeTitle={active?.title}
        onCreate={onCreateConversation}
        onOpen={onOpenConversation}
        onRename={onRenameConversation}
        onDelete={onDeleteConversation}
      />
    </div>
  )
}

function ChatHistoryMenu({
  conversations,
  activeID,
  activeTitle,
  onCreate,
  onOpen,
  onRename,
  onDelete,
}: {
  conversations: ConversationSummary[]
  activeID?: string
  activeTitle?: string
  onCreate: () => void
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [renamingID, setRenamingID] = useState<string>()
  const [renamingTitle, setRenamingTitle] = useState("")
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const startRename = (conversation: ConversationSummary) => {
    setRenamingID(conversation.id)
    setRenamingTitle(conversation.title)
  }

  const commitRename = () => {
    if (!renamingID) return
    const title = renamingTitle.replace(/\s+/g, " ").trim()
    if (!title) return
    onRename(renamingID, title.slice(0, 80))
    setRenamingID(undefined)
    setRenamingTitle("")
  }

  const remove = (id: string) => {
    onDelete(id)
    if (renamingID === id) {
      setRenamingID(undefined)
      setRenamingTitle("")
    }
  }

  return (
    <div className="history-menu" ref={ref}>
      <button
        className={`history-trigger ${open ? "is-open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-label="Chat history"
        title={activeTitle ? `Chat history: ${activeTitle}` : "Chat history"}
      >
        <span className="history-clock" />
      </button>
      {open && (
        <div className="history-popover">
          <div className="history-popover-title">Chat history</div>
          <button
            className="history-new"
            onClick={() => {
              setOpen(false)
              onCreate()
            }}
          >
            New chat
          </button>
          <div className="history-list">
            {conversations.length === 0 && <div className="history-empty">No chats yet</div>}
            {conversations.map((conversation) => (
              <div
                className={`history-item ${conversation.id === activeID ? "is-active" : ""} ${conversation.id === renamingID ? "is-editing" : ""}`}
                key={conversation.id}
              >
                {conversation.id === renamingID ? (
                  <>
                    <input
                      className="history-rename-input"
                      value={renamingTitle}
                      autoFocus
                      onChange={(event) => setRenamingTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitRename()
                        if (event.key === "Escape") setRenamingID(undefined)
                      }}
                    />
                    <button className="history-action" onClick={commitRename}>
                      Save
                    </button>
                    <button className="history-action" onClick={() => setRenamingID(undefined)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="history-open"
                      onClick={() => {
                        setOpen(false)
                        onOpen(conversation.id)
                      }}
                      title={conversation.title}
                    >
                      <span className="history-title">{conversation.title}</span>
                      <span className="history-date">{formatUpdated(conversation.updatedAt)}</span>
                    </button>
                    <button className="history-action" onClick={() => startRename(conversation)} title="Rename">
                      Rename
                    </button>
                    <button className="history-action danger" onClick={() => remove(conversation.id)} title="Delete">
                      Delete
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function formatUpdated(updatedAt: number) {
  const date = new Date(updatedAt)
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
}
