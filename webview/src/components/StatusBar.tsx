import { useEffect, useRef, useState } from "react"
import type { ConversationSummary, Selection } from "../protocol"

type Props = {
  connected: boolean
  error?: string
  continuationPending?: boolean
  selection: Selection
  conversations: ConversationSummary[]
  activeConversationID?: string
  onSelectAgent: () => void
  onSelectModel: () => void
  onSelectVariant: () => void
  onCreateConversation: () => void
  onOpenConversation: (id: string) => void
  onRenameConversation: (id: string, title: string) => void
  onDeleteConversation: (id: string) => void
}

export function StatusBar({
  connected,
  error,
  continuationPending,
  selection,
  conversations,
  activeConversationID,
  onSelectAgent,
  onSelectModel,
  onSelectVariant,
  onCreateConversation,
  onOpenConversation,
  onRenameConversation,
  onDeleteConversation,
}: Props) {
  const agent = selection.agent ?? "default"
  const model = selection.model ?? "default"
  const variant = selection.modelVariant
  const active = conversations.find((c) => c.id === activeConversationID)

  const showStatus = !connected || Boolean(error) || Boolean(continuationPending)
  const statusLabel = error
    ? `error · ${error}`
    : !connected
      ? "connecting…"
      : continuationPending
        ? "continuing…"
        : ""
  const dotKind = error ? "err" : continuationPending ? "pending" : connected ? "ok" : "warn"
  return (
    <div className={`statusbar ${showStatus ? "" : "is-quiet"}`}>
      <span
        className={`dot ${dotKind}`}
        title={error ? `error · ${error}` : continuationPending ? "continuing…" : connected ? "connected" : "connecting…"}
      />
      {showStatus && statusLabel && (
        <span className="status-text">{statusLabel}</span>
      )}
      <div className="spacer" />
      <SelectorMenu
        agent={agent}
        model={model}
        variant={variant}
        onSelectAgent={onSelectAgent}
        onSelectModel={onSelectModel}
        onSelectVariant={onSelectVariant}
      />
      <button
        type="button"
        className="new-chat-trigger"
        onClick={onCreateConversation}
        aria-label="New chat"
        title="New chat"
      >
        <span className="new-chat-icon" aria-hidden="true" />
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
  const [confirmDeleteID, setConfirmDeleteID] = useState<string>()
  const [query, setQuery] = useState("")
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

  useEffect(() => {
    if (!open) {
      setQuery("")
      setConfirmDeleteID(undefined)
    }
  }, [open])

  useEffect(() => {
    if (!confirmDeleteID) return
    const handle = window.setTimeout(() => setConfirmDeleteID(undefined), 3000)
    return () => window.clearTimeout(handle)
  }, [confirmDeleteID])

  const startRename = (conversation: ConversationSummary) => {
    setRenamingID(conversation.id)
    setRenamingTitle(conversation.title)
    setConfirmDeleteID(undefined)
  }

  const commitRename = () => {
    if (!renamingID) return
    const title = renamingTitle.replace(/\s+/g, " ").trim()
    if (!title) return
    onRename(renamingID, title.slice(0, 80))
    setRenamingID(undefined)
    setRenamingTitle("")
  }

  const handleDelete = (id: string) => {
    if (confirmDeleteID === id) {
      onDelete(id)
      setConfirmDeleteID(undefined)
      if (renamingID === id) {
        setRenamingID(undefined)
        setRenamingTitle("")
      }
      return
    }
    setConfirmDeleteID(id)
  }

  const filtered = query.trim()
    ? conversations.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()))
    : conversations
  const showSearch = conversations.length >= 5

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
          <div className="history-popover-header">
            <div className="history-popover-title">Chat history</div>
            <button
              type="button"
              className="history-new"
              onClick={() => {
                setOpen(false)
                onCreate()
              }}
            >
              <span className="history-new-icon" aria-hidden="true" />
              <span className="history-new-text">New chat</span>
            </button>
          </div>
          {showSearch && (
            <input
              className="history-search"
              type="text"
              placeholder="Search chats…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          <div className="history-list">
            {conversations.length === 0 && <div className="history-empty">No chats yet</div>}
            {conversations.length > 0 && filtered.length === 0 && (
              <div className="history-empty">No chats match “{query}”</div>
            )}
            {filtered.map((conversation) => {
              const isConfirming = conversation.id === confirmDeleteID
              const isEditing = conversation.id === renamingID
              return (
                <div
                  className={`history-item ${conversation.id === activeID ? "is-active" : ""} ${isEditing ? "is-editing" : ""} ${isConfirming ? "is-confirming" : ""}`}
                  key={conversation.id}
                >
                  {isEditing ? (
                    <>
                      <input
                        className="history-rename-input"
                        value={renamingTitle}
                        autoFocus
                        onChange={(event) => setRenamingTitle(event.target.value)}
                        onKeyDown={(event) => {
                          // While IME composition is active, Enter commits
                          // the IME candidate — don't intercept it as Save.
                          if (event.nativeEvent.isComposing || event.keyCode === 229) return
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
                      <button
                        className={`history-action danger ${isConfirming ? "is-confirming" : ""}`}
                        onClick={() => handleDelete(conversation.id)}
                        title={isConfirming ? "Click again to delete" : "Delete"}
                      >
                        {isConfirming ? "Confirm" : "Delete"}
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export function formatUpdated(updatedAt: number) {
  const date = new Date(updatedAt)
  const now = Date.now()
  const diff = now - updatedAt
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < 30 * 1000) return "just now"
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))}m ago`
  if (diff < day) return `${Math.floor(diff / hour)}h ago`

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const yesterday = new Date(startOfToday.getTime() - day)
  if (date >= yesterday && date < startOfToday) return "yesterday"

  const weekStart = new Date(startOfToday)
  weekStart.setDate(startOfToday.getDate() - 6)
  if (date >= weekStart) return date.toLocaleDateString([], { weekday: "short" })

  if (date.getFullYear() === startOfToday.getFullYear()) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" })
  }
  return date.toLocaleDateString([], { month: "short", year: "numeric" })
}

function SelectorMenu({
  agent,
  model,
  variant,
  onSelectAgent,
  onSelectModel,
  onSelectVariant,
}: {
  agent: string
  model: string
  variant?: string
  onSelectAgent: () => void
  onSelectModel: () => void
  onSelectVariant: () => void
}) {
  const [open, setOpen] = useState(false)
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

  const prettyModel = formatModel(model)
  const prettyAgent = formatAgent(agent)
  const prettyVariant = variant ?? "default"
  const triggerTitle = `Model: ${model}${variant ? ` (effort: ${variant})` : ""}\nAgent: ${agent}`

  return (
    <div className="selector-menu" ref={ref}>
      <button
        className={`selector-trigger ${open ? "is-open" : ""}`}
        onClick={() => setOpen(!open)}
        title={triggerTitle}
        aria-label="Change agent, model, and effort"
        aria-expanded={open}
      >
        <span className="selector-prefix">Model</span>
        <span className="selector-primary">{prettyModel}</span>
        {variant && <span className="selector-variant-chip">{variant}</span>}
        <span className="selector-sep">·</span>
        <span className="selector-prefix">Agent</span>
        <span className="selector-secondary">{prettyAgent}</span>
      </button>
      {open && (
        <div className="selector-popover" role="menu">
          <button
            type="button"
            className="selector-row"
            role="menuitem"
            onClick={() => {
              onSelectModel()
              setOpen(false)
            }}
          >
            <span className="selector-row-label">Model</span>
            <span className="selector-row-value" title={model}>{prettyModel}</span>
            <span className="selector-row-arrow">›</span>
          </button>
          <button
            type="button"
            className="selector-row"
            role="menuitem"
            onClick={() => {
              onSelectVariant()
              setOpen(false)
            }}
            title="Change effort / thinking budget for the current model"
          >
            <span className="selector-row-label">Effort</span>
            <span className="selector-row-value" title={variant ?? "default"}>{prettyVariant}</span>
            <span className="selector-row-arrow">›</span>
          </button>
          <button
            type="button"
            className="selector-row"
            role="menuitem"
            onClick={() => {
              onSelectAgent()
              setOpen(false)
            }}
          >
            <span className="selector-row-label">Agent</span>
            <span className="selector-row-value" title={agent}>{prettyAgent}</span>
            <span className="selector-row-arrow">›</span>
          </button>
        </div>
      )}
    </div>
  )
}

export function formatModel(name: string): string {
  if (!name || name === "default") return name || "default"
  let value = stripProvider(name)
  value = stripTrailingDate(value)

  const claude = matchClaude(value)
  if (claude) return claude
  const gpt = matchGPT(value)
  if (gpt) return gpt
  const gemini = matchGemini(value)
  if (gemini) return gemini

  if (value.length <= 24) return prettifyToken(value)
  return prettifyToken(value.slice(0, 22)) + "…"
}

export function formatAgent(slug: string): string {
  if (!slug || slug === "default") return slug || "default"
  return prettifyToken(slug)
}

function stripProvider(name: string): string {
  return name.replace(/^(anthropic|openai|google|meta|mistral|cohere|fireworks|together|deepseek|xai|x-ai|groq)[/.:-]/i, "")
}

function stripTrailingDate(name: string): string {
  return name
    .replace(/[-_]?(\d{4})-(\d{2})-(\d{2})$/, "")
    .replace(/[-_]?\d{8}$/, "")
    .replace(/[-_]?\d{6}$/, "")
}

function matchClaude(value: string): string | undefined {
  if (!/claude/i.test(value)) return undefined
  const family = value.match(/(opus|sonnet|haiku|instant)/i)?.[1]
  const versioned = value.match(/(\d+)[-_.](\d+)/)
  const single = !versioned ? value.match(/(?:^|[^a-z\d])(\d+)/i) : undefined
  const familyLabel = family ? capitalize(family) : "Claude"
  if (versioned) return `${familyLabel} ${versioned[1]}.${versioned[2]}`
  if (single) return `${familyLabel} ${single[1]}`
  return family ? familyLabel : undefined
}

function matchGPT(value: string): string | undefined {
  const m = value.match(/^gpt[-_]?(\d+(?:\.\d+)?)([a-z]*)[-_]?(turbo|preview|mini|nano)?/i)
  if (!m) return undefined
  const version = m[1]
  const variant = m[2]?.toLowerCase()
  const tier = m[3]
  let label = `GPT-${version}`
  if (variant === "o") label += "o"
  if (tier) label += ` ${capitalize(tier)}`
  return label
}

function matchGemini(value: string): string | undefined {
  const m = value.match(/^gemini[-_]?(\d+(?:\.\d+)?)?[-_]?(pro|flash|ultra|nano)?/i)
  if (!m) return undefined
  const version = m[1]
  const tier = m[2]
  if (!version && !tier) return undefined
  const parts = ["Gemini"]
  if (version) parts.push(version)
  if (tier) parts.push(capitalize(tier))
  return parts.join(" ")
}

function prettifyToken(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => /^\d/.test(part) ? part : capitalize(part))
    .join(" ")
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() : value
}
