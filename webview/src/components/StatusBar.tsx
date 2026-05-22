import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react"
import type { AgentsStatusInfo, AgentsTaskInfo, ConversationSummary, Selection } from "../protocol"
import { useDismissableMenu } from "../hooks/useDismissableMenu"
import { useHeaderPopoverHeight } from "../hooks/useHeaderPopoverHeight"
import { StatusIndicator, type StatusIndicatorKind } from "./StatusIndicator"

export type HeaderPopoverID = "selector" | "agents" | "history"
type HeaderPopoverSetter = Dispatch<SetStateAction<HeaderPopoverID | null>>

type Props = {
  connected: boolean
  error?: string
  continuationPending?: boolean
  selection: Selection
  conversations: ConversationSummary[]
  activeConversationID?: string
  agentsStatus?: AgentsStatusInfo
  activePopover?: HeaderPopoverID | null
  onActivePopoverChange?: HeaderPopoverSetter
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
  agentsStatus,
  activePopover,
  onActivePopoverChange,
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
  const [localActivePopover, setLocalActivePopover] = useState<HeaderPopoverID | null>(null)
  const currentPopover = activePopover === undefined ? localActivePopover : activePopover
  const setCurrentPopover = onActivePopoverChange ?? setLocalActivePopover
  const setPopoverOpen = (id: HeaderPopoverID, open: boolean) => {
    setCurrentPopover((current) => open ? id : current === id ? null : current)
  }

  const showStatus = !connected || Boolean(error) || Boolean(continuationPending)
  const statusLabel: string | undefined = error
    ? `error · ${error}`
    : !connected
      ? "connecting…"
      : continuationPending
        ? "continuing…"
        : undefined
  const dotKind: StatusIndicatorKind = error
    ? "err"
    : continuationPending
      ? "pending"
      : connected
        ? "ok"
        : "warn"
  const statusTitle = error
    ? `error · ${error}`
    : continuationPending
      ? "continuing…"
      : connected
        ? "connected"
        : "connecting…"
  return (
    <div className="statusbar">
      <StatusIndicator
        kind={dotKind}
        label={showStatus ? statusLabel : undefined}
        title={statusTitle}
      />
      <div className="spacer" />
      <SelectorMenu
        agent={agent}
        model={model}
        variant={variant}
        open={currentPopover === "selector"}
        onOpenChange={(open) => setPopoverOpen("selector", open)}
        onSelectAgent={onSelectAgent}
        onSelectModel={onSelectModel}
        onSelectVariant={onSelectVariant}
      />
      <AgentsMenu
        status={agentsStatus}
        open={currentPopover === "agents"}
        onOpenChange={(open) => setPopoverOpen("agents", open)}
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
        open={currentPopover === "history"}
        onOpenChange={(open) => setPopoverOpen("history", open)}
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
  open,
  onOpenChange,
  onCreate,
  onOpen,
  onRename,
  onDelete,
}: {
  conversations: ConversationSummary[]
  activeID?: string
  activeTitle?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: () => void
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}) {
  const { toggle, close, ref } = useDismissableMenu({ open, onOpenChange })
  const popoverRef = useRef<HTMLDivElement>(null)
  useHeaderPopoverHeight(open, popoverRef)
  const [renamingID, setRenamingID] = useState<string>()
  const [renamingTitle, setRenamingTitle] = useState("")
  const [confirmDeleteID, setConfirmDeleteID] = useState<string>()
  const [query, setQuery] = useState("")

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
        onClick={toggle}
        aria-label="Chat history"
        title={activeTitle ? `Chat history: ${activeTitle}` : "Chat history"}
      >
        <span className="history-clock" />
      </button>
      {open && (
        <div className="history-popover" ref={popoverRef}>
          <div className="history-popover-header">
            <div className="history-popover-title">Chat history</div>
            <button
              type="button"
              className="history-new"
              onClick={() => {
                close()
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
                          close()
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

/**
 * Always-visible `Agents` menu in the chat header, sitting between the
 * Model/Agent selector and the new-chat button. The host scopes the snapshot
 * to the active conversation, so `tasks` only contains work for THIS chat.
 * Clicking the pill toggles an inline popover (matching the SelectorMenu
 * pattern) that lists tasks grouped by Main / Subagents.
 *
 * The pill text never changes (always literally `Agents`); state is signalled
 * by color — muted when idle, breathing green while running, attention red
 * for error, amber for waiting.
 */
function AgentsMenu({
  status,
  open,
  onOpenChange,
}: {
  status?: AgentsStatusInfo
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { toggle, ref } = useDismissableMenu({ open, onOpenChange })
  const popoverRef = useRef<HTMLDivElement>(null)
  useHeaderPopoverHeight(open, popoverRef)

  const running = (status?.running ?? 0) > 0
  const errorOnly = !running && (status?.error ?? 0) > 0
  const waitingOnly = !running && !errorOnly && (status?.waiting ?? 0) > 0
  const idle = !running && !errorOnly && !waitingOnly
  const className =
    "agents-pill" +
    (open ? " is-open" : "") +
    (running ? " is-running" : "") +
    (errorOnly ? " is-error" : "") +
    (waitingOnly ? " is-waiting" : "") +
    (idle ? " is-idle" : "")
  const tasks = status?.tasks ?? []
  const main = tasks.filter((t) => t.kind === "main")
  const sub = tasks.filter((t) => t.kind === "subagent")
  const empty = tasks.length === 0

  return (
    <div className="agents-menu" ref={ref}>
      <button
        type="button"
        className={className}
        onClick={toggle}
        title={buildAgentsTitle(status)}
        aria-label="Open agents for this chat"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Agents
      </button>
      {open && (
        <div className="agents-popover" role="menu" ref={popoverRef}>
          <div className="agents-popover-title">Agents in this chat</div>
          {empty && <div className="agents-popover-empty">No agents in this chat</div>}
          {!empty && (
            <div className="agents-popover-scroll">
              {main.length > 0 && (
                <>
                  <div className="agents-popover-section">Main</div>
                  {main.map((task) => (
                    <AgentsRow key={task.id} task={task} />
                  ))}
                </>
              )}
              {sub.length > 0 && (
                <>
                  <div className="agents-popover-section">Subagents</div>
                  {sub.map((task) => (
                    <AgentsRow key={task.id} task={task} />
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AgentsRow({ task }: { task: AgentsTaskInfo }) {
  const isLive = task.status === "running" || task.status === "waiting"
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isLive) return
    const handle = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(handle)
  }, [isLive])
  // Live rows tick `now` for a moving stopwatch. Terminal rows freeze
  // the elapsed at the store's `updatedAt` so a completed subagent
  // shows its true total runtime, not "minutes since the popover
  // happened to render".
  const elapsedMs = isLive ? now - task.startedAt : task.updatedAt - task.startedAt
  const elapsed = formatElapsed(elapsedMs)
  const statusText = task.status === "error" && task.error
    ? `error · ${task.error}`
    : task.status
  // Build the per-subagent "agent · model" sublabel from the metadata
  // omo writes on dispatch (`update.metadata` → AgentTask). Either piece
  // can be missing — opencode's built-in task tool doesn't publish a
  // model — so we render whatever subset is present.
  const subagentLabel = task.subagent ? formatAgent(task.subagent) : undefined
  const modelLabel = task.model ? formatModel(`${task.model.providerID}/${task.model.modelID}`) : undefined
  const categoryLabel = task.category && task.category !== task.subagent ? task.category : undefined
  const detailParts = [
    categoryLabel ? `category: ${categoryLabel}` : undefined,
    subagentLabel,
    modelLabel,
  ].filter((part): part is string => Boolean(part))
  const detail = detailParts.length > 0 ? detailParts.join(" · ") : undefined
  const tooltip = [task.title, statusText, elapsed, detail].filter(Boolean).join(" · ")
  return (
    <div className={`agents-row agents-row-${task.status}`} title={tooltip}>
      <span className="agents-row-title">{task.title}</span>
      <span className="agents-row-meta">{statusText} · {elapsed}</span>
      {detail && <span className="agents-row-detail">{detail}</span>}
    </div>
  )
}

export function buildAgentsTitle(status?: AgentsStatusInfo): string {
  if (!status || status.total === 0) {
    return "No agents in this chat\nClick to view"
  }
  const lines: string[] = []
  if (status.running > 0)
    lines.push(`${status.running} agent${status.running === 1 ? "" : "s"} running`)
  if (status.waiting > 0) lines.push(`${status.waiting} waiting for input`)
  if (status.error > 0) lines.push(`${status.error} with errors`)
  lines.push("Click to view")
  return lines.join("\n")
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes - hours * 60
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`
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
  open,
  onOpenChange,
  onSelectAgent,
  onSelectModel,
  onSelectVariant,
}: {
  agent: string
  model: string
  variant?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectAgent: () => void
  onSelectModel: () => void
  onSelectVariant: () => void
}) {
  const { toggle, close, ref } = useDismissableMenu({ open, onOpenChange })
  const popoverRef = useRef<HTMLDivElement>(null)
  useHeaderPopoverHeight(open, popoverRef)

  const prettyModel = formatModel(model)
  const prettyAgent = formatAgent(agent)
  const prettyVariant = variant ?? "default"
  const triggerTitle = `Model: ${model}${variant ? ` (effort: ${variant})` : ""}\nAgent: ${agent}`

  return (
    <div className="selector-menu" ref={ref}>
      <button
        className={`selector-trigger ${open ? "is-open" : ""}`}
        onClick={toggle}
        title={triggerTitle}
        aria-label="Change agent, model, and effort"
        aria-expanded={open}
      >
        <span className="selector-prefix">Model</span>
        <span className="selector-primary">{prettyModel}</span>
        {variant && (
          <>
            <span className="selector-sep">·</span>
            <span className="selector-prefix">Effort</span>
            <span className="selector-variant">{variant}</span>
          </>
        )}
        <span className="selector-sep">·</span>
        <span className="selector-prefix">Agent</span>
        <span className="selector-secondary">{prettyAgent}</span>
      </button>
      {open && (
        <div className="selector-popover" role="menu" ref={popoverRef}>
          <button
            type="button"
            className="selector-row"
            role="menuitem"
            onClick={() => {
              onSelectModel()
              close()
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
              close()
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
              close()
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
