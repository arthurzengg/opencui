import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react"
import type {
  ConversationSummary,
  ExternalSessionSummary,
  ModelCatalogInfo,
  PermissionRuleInfo,
  Selection,
} from "../protocol"
import { useDismissableMenu } from "../hooks/useDismissableMenu"
import { StatusIndicator, type StatusIndicatorKind } from "./StatusIndicator"
import { ModelPicker } from "./ModelPicker"

export type HeaderPopoverID = "selector" | "history" | "permissions"
type HeaderPopoverSetter = Dispatch<SetStateAction<HeaderPopoverID | null>>

const EXTERNAL_SEARCH_DEBOUNCE_MS = 250

type Props = {
  connected: boolean
  error?: string
  continuationPending?: boolean
  selection: Selection
  modelCatalog?: ModelCatalogInfo
  conversations: ConversationSummary[]
  externalSessions?: ExternalSessionSummary[]
  permissionRules?: PermissionRuleInfo[]
  activeConversationID?: string
  activePopover?: HeaderPopoverID | null
  onActivePopoverChange?: HeaderPopoverSetter
  onSetAgent: (name?: string) => void
  onSetModel: (providerID?: string, modelID?: string, variant?: string) => void
  onSetProviderCollapsed: (providerID: string, collapsed: boolean) => void
  onRefreshModels: () => void
  onCreateConversation: () => void
  onOpenConversation: (id: string) => void
  onImportSession?: (sessionID: string) => void
  onRefreshSessions?: (search?: string) => void
  onRenameConversation: (id: string, title: string) => void
  onDeleteConversation: (id: string) => void
  onDeleteSession?: (sessionID: string) => void
  onRemovePermissionRule?: (id: string) => void
  onClearPermissionRules?: () => void
}

export function StatusBar({
  connected,
  error,
  continuationPending,
  selection,
  modelCatalog,
  conversations,
  externalSessions,
  permissionRules,
  activeConversationID,
  activePopover,
  onActivePopoverChange,
  onSetAgent,
  onSetModel,
  onSetProviderCollapsed,
  onRefreshModels,
  onCreateConversation,
  onOpenConversation,
  onImportSession,
  onRefreshSessions,
  onRenameConversation,
  onDeleteConversation,
  onDeleteSession,
  onRemovePermissionRule,
  onClearPermissionRules,
}: Props) {
  const active = conversations.find((c) => c.id === activeConversationID)
  const [localActivePopover, setLocalActivePopover] = useState<HeaderPopoverID | null>(null)
  const currentPopover = activePopover === undefined ? localActivePopover : activePopover
  const setCurrentPopover = onActivePopoverChange ?? setLocalActivePopover
  const setPopoverOpen = (id: HeaderPopoverID, open: boolean) => {
    setCurrentPopover((current) => open ? id : current === id ? null : current)
  }

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
      <StatusIndicator kind={dotKind} title={statusTitle} />
      <div className="spacer" />
      <SelectorMenu
        selection={selection}
        catalog={modelCatalog}
        open={currentPopover === "selector"}
        onOpenChange={(open) => setPopoverOpen("selector", open)}
        onSetAgent={onSetAgent}
        onSetModel={onSetModel}
        onSetProviderCollapsed={onSetProviderCollapsed}
        onRefreshModels={onRefreshModels}
      />
      {permissionRules && permissionRules.length > 0 && onRemovePermissionRule && (
        <PermissionRulesMenu
          rules={permissionRules}
          open={currentPopover === "permissions"}
          onOpenChange={(open) => setPopoverOpen("permissions", open)}
          onRemove={onRemovePermissionRule}
          onClear={onClearPermissionRules}
        />
      )}
      <button
        type="button"
        className="new-chat-trigger"
        onClick={onCreateConversation}
        aria-label="New chat"
        title="New chat"
      >
        <span className="codicon codicon-add" aria-hidden="true" />
      </button>
      <ChatHistoryMenu
        conversations={conversations}
        external={externalSessions ?? []}
        activeID={activeConversationID}
        activeTitle={active?.title}
        open={currentPopover === "history"}
        onOpenChange={(open) => setPopoverOpen("history", open)}
        onCreate={onCreateConversation}
        onOpen={onOpenConversation}
        onImport={onImportSession}
        onRefreshExternal={onRefreshSessions}
        onRename={onRenameConversation}
        onDelete={onDeleteConversation}
        onDeleteSession={onDeleteSession}
      />
    </div>
  )
}

export type HistoryRow =
  | { kind: "conversation"; key: string; title: string; updatedAt: number; conversation: ConversationSummary }
  | { kind: "session"; key: string; title: string; updatedAt: number; session: ExternalSessionSummary }

/**
 * One list for the popover: saved conversations and unopened server sessions
 * interleaved by last activity (#660). Where the record lives is not the
 * user's concern; an unopened row imports on click and deletes on the server
 * like any other.
 */
export function mergeHistoryRows(
  conversations: ConversationSummary[],
  external: ExternalSessionSummary[],
): HistoryRow[] {
  const rows: HistoryRow[] = [
    ...conversations.map((c) => ({
      kind: "conversation" as const,
      key: `conv:${c.id}`,
      title: c.title,
      updatedAt: c.updatedAt,
      conversation: c,
    })),
    ...external.map((s) => ({
      kind: "session" as const,
      key: `sess:${s.id}`,
      title: s.title,
      updatedAt: s.updatedAt,
      session: s,
    })),
  ]
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

function ChatHistoryMenu({
  conversations,
  external,
  activeID,
  activeTitle,
  open,
  onOpenChange,
  onCreate,
  onOpen,
  onImport,
  onRefreshExternal,
  onRename,
  onDelete,
  onDeleteSession,
}: {
  conversations: ConversationSummary[]
  external: ExternalSessionSummary[]
  activeID?: string
  activeTitle?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: () => void
  onOpen: (id: string) => void
  onImport?: (sessionID: string) => void
  onRefreshExternal?: (search?: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onDeleteSession?: (sessionID: string) => void
}) {
  const { toggle, close, ref } = useDismissableMenu({ open, onOpenChange })
  const [renamingID, setRenamingID] = useState<string>()
  const [renamingTitle, setRenamingTitle] = useState("")
  const [confirmDeleteID, setConfirmDeleteID] = useState<string>()
  const [query, setQuery] = useState("")
  const lastSearch = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!open) {
      setQuery("")
      setConfirmDeleteID(undefined)
      return
    }
    // Stale-while-revalidate: the last known external list renders instantly,
    // and opening the popover re-fetches so TUI sessions started since the
    // panel mounted show up.
    lastSearch.current = undefined
    onRefreshExternal?.()
  }, [open])

  // The local filter below answers instantly from the last fetch; the server
  // search finds sessions beyond that page (#617). Debounced per keystroke.
  useEffect(() => {
    if (!open) return
    const search = query.trim() || undefined
    if (search === lastSearch.current) return
    const handle = window.setTimeout(() => {
      lastSearch.current = search
      onRefreshExternal?.(search)
    }, EXTERNAL_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [open, query])

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

  const handleDelete = (row: HistoryRow) => {
    if (confirmDeleteID !== row.key) {
      setConfirmDeleteID(row.key)
      return
    }
    if (row.kind === "conversation") onDelete(row.conversation.id)
    else onDeleteSession?.(row.session.id)
    setConfirmDeleteID(undefined)
  }

  const rows = mergeHistoryRows(conversations, external)
  const needle = query.trim().toLowerCase()
  const filtered = needle ? rows.filter((row) => row.title.toLowerCase().includes(needle)) : rows
  const showSearch = rows.length >= 5

  return (
    <div className="history-menu" ref={ref}>
      <button
        className={`history-trigger ${open ? "is-open" : ""}`}
        onClick={toggle}
        aria-label="Chat history"
        title={activeTitle ? `Chat history: ${activeTitle}` : "Chat history"}
      >
        <span className="codicon codicon-history" aria-hidden="true" />
      </button>
      {open && (
        <div className="history-popover">
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
              <span className="codicon codicon-add" aria-hidden="true" />
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
            {rows.length === 0 && <div className="history-empty">No chats yet</div>}
            {rows.length > 0 && filtered.length === 0 && (
              <div className="history-empty">No chats match “{query}”</div>
            )}
            {filtered.map((row) => {
              const isConfirming = row.key === confirmDeleteID
              const isEditing = row.kind === "conversation" && row.conversation.id === renamingID
              const isActive = row.kind === "conversation" && row.conversation.id === activeID
              return (
                <div
                  className={`history-item ${isActive ? "is-active" : ""} ${isEditing ? "is-editing" : ""} ${isConfirming ? "is-confirming" : ""}`}
                  key={row.key}
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
                          if (event.key === "Escape") {
                            // Consume so Esc-to-stop doesn't also abort the turn.
                            event.preventDefault()
                            setRenamingID(undefined)
                          }
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
                          if (row.kind === "conversation") onOpen(row.conversation.id)
                          else onImport?.(row.session.id)
                        }}
                        title={
                          row.kind === "session"
                            ? `${row.title} (opencode session from the TUI, web UI, or another client; opening saves it here)`
                            : row.title
                        }
                      >
                        <span className="history-title">{row.title}</span>
                        <span className="history-date">{formatUpdated(row.updatedAt)}</span>
                      </button>
                      {row.kind === "conversation" && (
                        <button className="history-action" onClick={() => startRename(row.conversation)} title="Rename">
                          Rename
                        </button>
                      )}
                      <button
                        className={`history-action danger ${isConfirming ? "is-confirming" : ""}`}
                        onClick={() => handleDelete(row)}
                        title={
                          isConfirming
                            ? "Click again to delete from opencode and this panel"
                            : "Delete from opencode and this panel"
                        }
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
 * The panel's saved "Allow always" rules (#619). Rendered only while rules
 * exist, so the bar stays as it was for anyone who never answered "always".
 */
function PermissionRulesMenu({
  rules,
  open,
  onOpenChange,
  onRemove,
  onClear,
}: {
  rules: PermissionRuleInfo[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onRemove: (id: string) => void
  onClear?: () => void
}) {
  const { toggle, ref } = useDismissableMenu({ open, onOpenChange })
  const label = `Saved permission rules (${rules.length})`
  return (
    <div className="history-menu permission-rules-menu" ref={ref}>
      <button
        type="button"
        className={`history-trigger ${open ? "is-open" : ""}`}
        onClick={toggle}
        aria-label={label}
        aria-expanded={open}
        title={label}
      >
        <span className="codicon codicon-shield" aria-hidden="true" />
      </button>
      {open && (
        <div className="history-popover permission-rules-popover" role="dialog" aria-label="Saved permission rules">
          <div className="history-popover-header">
            <div className="history-popover-title">Saved permission rules</div>
            {onClear && (
              <button type="button" className="permission-rules-clear" onClick={onClear}>
                Remove all
              </button>
            )}
          </div>
          <div className="history-list">
            {rules.map((rule) => (
              <div className="history-item permission-rule" key={rule.id}>
                <div className="permission-rule-label" title={`${rule.permission}: ${rule.pattern}`}>
                  <span className="permission-rule-permission">{rule.permission}</span>
                  <code className="permission-rule-pattern">{rule.pattern}</code>
                </div>
                <span className="history-date">{formatUpdated(rule.createdAt)}</span>
                <button
                  type="button"
                  className="history-action danger"
                  onClick={() => onRemove(rule.id)}
                  title="Remove this rule"
                  aria-label={`Remove rule ${rule.permission} ${rule.pattern}`}
                >
                  Remove
                </button>
              </div>
            ))}
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
  selection,
  catalog,
  open,
  onOpenChange,
  onSetAgent,
  onSetModel,
  onSetProviderCollapsed,
  onRefreshModels,
}: {
  selection: Selection
  catalog?: ModelCatalogInfo
  open: boolean
  onOpenChange: (open: boolean) => void
  onSetAgent: (name?: string) => void
  onSetModel: (providerID?: string, modelID?: string, variant?: string) => void
  onSetProviderCollapsed: (providerID: string, collapsed: boolean) => void
  onRefreshModels: () => void
}) {
  const { toggle, ref } = useDismissableMenu({ open, onOpenChange })

  const agent = selection.agent ?? "default"
  const model = selection.model ?? "default"
  const variant = selection.modelVariant
  const prettyModel = formatModel(model)
  const prettyAgent = formatAgent(agent)
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
        <span className="selector-sep">·</span>
        <span className="selector-prefix">Effort</span>
        <span className="selector-variant">{variant ?? "default"}</span>
        <span className="selector-sep">·</span>
        <span className="selector-prefix">Agent</span>
        <span className="selector-secondary">{prettyAgent}</span>
      </button>
      {open && (
        <div className="model-picker-popover" role="dialog" aria-label="Select model, effort, and agent">
          <ModelPicker
            catalog={catalog}
            selection={selection}
            onSetModel={onSetModel}
            onSetAgent={onSetAgent}
            onSetProviderCollapsed={onSetProviderCollapsed}
            onRefresh={onRefreshModels}
          />
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
