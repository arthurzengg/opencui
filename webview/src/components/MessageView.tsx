import { useEffect, useRef, useState, type ReactNode } from "react"
import type { Block, Message } from "../hooks/useChatState"
import { Markdown } from "./Markdown"
import { ToolTrace, toolHeadline } from "./ToolCard"

export function MessageView({
  message,
  processOpen,
  processOnly,
  busy,
  onReviewFile,
  onEditMessage,
}: {
  message: Message
  processOpen: boolean
  processOnly: boolean
  busy?: boolean
  onReviewFile?: (path: string) => void
  onEditMessage?: (id: string, text: string) => void
}) {
  if (message.role === "user") {
    return (
      <UserMessageView message={message} busy={busy} onEditMessage={onEditMessage} />
    )
  }
  return (
    <div className={`msg role-${message.role}`}>
      {message.ref?.label && <div className="msg-ref">{message.ref.label}</div>}
      {renderMessageBlocks(message, processOpen, processOnly, onReviewFile)}
      {message.pending && message.blocks.length === 0 && (
        <div className="thinking-dots" role="status" aria-label="Thinking">thinking</div>
      )}
      {message.error && <div className="msg-error">{message.error}</div>}
      {(message.usage?.model || message.usage?.cost || message.usage?.tokens) && (
        <div className="msg-usage">
          {message.usage.model ? <span>{message.usage.model}</span> : null}
          {message.usage.model && (message.usage.cost || message.usage.tokens) ? " · " : null}
          {message.usage.cost ? <>${message.usage.cost.toFixed(4)}</> : null}
          {message.usage.cost && message.usage.tokens ? " · " : null}
          {message.usage.tokens && (
            <span>{message.usage.tokens.input + message.usage.tokens.output} tokens</span>
          )}
        </div>
      )}
    </div>
  )
}

function UserMessageView({
  message,
  busy,
  onEditMessage,
}: {
  message: Message
  busy?: boolean
  onEditMessage?: (id: string, text: string) => void
}) {
  const originalText = message.blocks
    .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(originalText)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) setDraft(originalText)
  }, [editing, originalText])

  useEffect(() => {
    const node = textareaRef.current
    if (!editing || !node) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
    node.style.height = "auto"
    node.style.height = Math.min(node.scrollHeight, 240) + "px"
  }, [editing])

  useEffect(() => {
    const node = textareaRef.current
    if (!editing || !node) return
    node.style.height = "auto"
    node.style.height = Math.min(node.scrollHeight, 240) + "px"
  }, [draft, editing])

  const canEdit = Boolean(onEditMessage)
  const editBlocked = busy || !message.backendID
  const editable = canEdit && !editBlocked
  const editTitle = !canEdit
    ? undefined
    : busy
      ? "Wait for the assistant to finish before editing"
      : !message.backendID
        ? "Saving your message — try again in a moment"
        : "Edit and regenerate"

  const submit = () => {
    const trimmed = draft.trim()
    if (!trimmed) return
    if (trimmed === originalText.trim()) {
      setEditing(false)
      return
    }
    onEditMessage?.(message.id, trimmed)
    setEditing(false)
  }

  const handleBubbleClick = () => {
    if (!editable || editing) return
    if (typeof window !== "undefined" && window.getSelection?.()?.toString()) return
    setEditing(true)
  }

  return (
    <div
      className={`msg role-user ${editing ? "is-editing" : ""} ${editable ? "is-editable" : ""}`}
      onClick={handleBubbleClick}
      role={editable ? "button" : undefined}
      tabIndex={editable ? 0 : undefined}
      onKeyDown={editable ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          setEditing(true)
        }
      } : undefined}
      title={editing ? undefined : editTitle}
    >
      {message.ref?.label && <div className="msg-ref">{message.ref.label}</div>}
      {editing ? (
        <div className="user-edit" onClick={(event) => event.stopPropagation()}>
          <textarea
            ref={textareaRef}
            className="user-edit-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                submit()
              }
              if (event.key === "Escape") {
                event.preventDefault()
                setEditing(false)
              }
            }}
          />
          <div className="user-edit-warning">
            Replies after this point will be discarded and regenerated.
          </div>
          <div className="user-edit-actions">
            <button className="btn subtle" onClick={() => setEditing(false)}>Cancel</button>
            <button
              className="btn primary"
              onClick={submit}
              disabled={!draft.trim() || draft.trim() === originalText.trim()}
            >
              Save & regenerate
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="user-text">{originalText}</div>
          {canEdit && (
            <span className="user-edit-hint" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8h7a3 3 0 0 1 0 6H6.5"/>
                <polyline points="5.5,5 3,8 5.5,11"/>
              </svg>
            </span>
          )}
        </>
      )}
    </div>
  )
}

function renderMessageBlocks(message: Message, processOpen: boolean, processOnly: boolean, onReviewFile?: (path: string) => void) {
  if (message.role !== "assistant") return renderBlocks(message.blocks, false, onReviewFile)
  const pending = Boolean(message.pending)
  if (processOnly) {
    if (!hasProcessBlocks(message.blocks)) return null
    return <ProcessPanel blocks={message.blocks} pending={pending} openKey={`process-only-${message.id}-${message.blocks.length}`} defaultOpen={processOpen} onReviewFile={onReviewFile} />
  }

  const finalTextIndex = lastTextIndex(message.blocks, message.pending)
  if (finalTextIndex < 0) {
    if (!hasProcessBlocks(message.blocks)) return renderBlocks(message.blocks, false, onReviewFile)
    return <ProcessPanel blocks={message.blocks} pending={pending} openKey={`process-${message.id}-${message.blocks.length}`} defaultOpen={processOpen} onReviewFile={onReviewFile} />
  }

  const process = message.blocks.slice(0, finalTextIndex)
  const final = message.blocks.slice(finalTextIndex)
  if (!hasProcessBlocks(process)) return renderBlocks(final, false, onReviewFile)
  return (
    <>
      <ProcessPanel blocks={process} pending={false} openKey={`final-${message.id}-${finalTextIndex}`} defaultOpen={false} onReviewFile={onReviewFile} />
      {renderBlocks(final, false, onReviewFile)}
    </>
  )
}

function ProcessPanel({
  blocks,
  pending,
  openKey,
  defaultOpen,
  onReviewFile,
}: {
  blocks: Block[]
  pending: boolean
  openKey: string
  defaultOpen: boolean
  onReviewFile?: (path: string) => void
}) {
  const [open, setOpen] = useState(defaultOpen)

  useEffect(() => {
    setOpen(defaultOpen)
  }, [defaultOpen, openKey])

  const title = pending ? processTitle(blocks) : processSummary(blocks) ?? processTitle(blocks)

  return (
    <div className="process">
      <button className="process-head" onClick={() => setOpen(!open)}>
        <span className="process-title">{title}</span>
        <span className={`process-caret ${open ? "is-open" : ""}`}>›</span>
      </button>
      {open && <div className="process-body">{renderBlocks(blocks, true, onReviewFile)}</div>}
    </div>
  )
}

function renderBlocks(blocks: Block[], processMode = false, onReviewFile?: (path: string) => void) {
  const nodes: ReactNode[] = []
  let tools: Extract<Block, { type: "tool" }>[] = []
  let patches: Extract<Block, { type: "patch" }>[] = []
  const flushTrace = () => {
    if (!tools.length && !patches.length) return
    nodes.push(
      <ToolTrace
        key={`trace-${nodes.length}`}
        updates={tools.map((b) => b.update)}
        patches={patches.map((b) => ({ files: b.files, diff: b.diff }))}
        onReviewFile={onReviewFile}
      />,
    )
    tools = []
    patches = []
  }
  blocks.forEach((b, i) => {
    if (b.type === "tool") {
      tools.push(b)
      return
    }
    if (b.type === "patch") {
      patches.push(b)
      return
    }
    flushTrace()
    if (b.type === "text") {
      const cleaned = stripInternalMarkers(b.text)
      if (!cleaned.trim()) return
      nodes.push(processMode ? <ProcessText key={i} text={cleaned} /> : <Markdown key={i} text={cleaned} />)
    }
    if (b.type === "reasoning") {
      const cleaned = stripInternalMarkers(b.text)
      if (!cleaned.trim()) return
      nodes.push(<ProcessText key={i} text={cleaned} />)
    }
  })
  flushTrace()
  return nodes
}

function ProcessText({ text }: { text: string }) {
  if (!text.trim()) return null
  const title = textTitle(text)
  if (!title) return <div className="process-text">{text}</div>
  const body = stripDuplicateTitle(text, title)
  return (
    <div className="process-text">
      <div className="process-text-title">{title}</div>
      {body && <div>{body}</div>}
    </div>
  )
}

export function hasProcessBlocks(blocks: Block[]) {
  return blocks.some((b) => {
    if (b.type === "text" || b.type === "reasoning") return b.text.trim().length > 0
    return true
  })
}

export function lastTextIndex(blocks: Block[], pending: boolean) {
  const mixedWithActivity = blocks.some((block) => block.type !== "text") || blocks.filter((block) => block.type === "text").length > 1
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (!block || block.type !== "text" || !block.text.trim()) continue
    if (looksLikeFinalAnswer(block.text)) return i
    if (looksLikeProcessText(block.text)) return -1
    if (!pending && !mixedWithActivity) return i
    return -1
  }
  return -1
}

export function looksLikeFinalAnswer(text: string) {
  const value = text.trim()
  if (/^[-*]\s+\[[ x]\]/m.test(value)) return true
  if (/^(short summary|summary|model|i['’]m|factoryflow)/i.test(value)) return true
  return value.length > 240 && !/\b(i('|’)m|i am)\s+(checking|reading|looking|inspecting|exploring|going to|falling back)\b/i.test(value)
}

export function looksLikeProcessText(text: string) {
  return /\b(i('|’)m|i am)\s+(checking|reading|looking|inspecting|exploring|going to|falling back|considering)\b/i.test(text)
    || /^(found|next|now|the quick|i detect|i’ve confirmed|i’ve got|i need to|let’s|this will help)\b/i.test(text.trim())
}

export function processTitle(blocks: Block[]) {
  const fromText = blocks.flatMap((block) =>
    block.type === "text" || block.type === "reasoning" ? [textTitle(block.text) ?? inferredTextTitle(block.text)] : [],
  ).find(Boolean)
  if (fromText) return fromText

  const tools = blocks.flatMap((block) => block.type === "tool" ? [block.update] : [])
  if (tools.length) return toolHeadline(tools)
  return "Working"
}

export function processSummary(blocks: Block[]) {
  const tools = blocks.flatMap((block) => block.type === "tool" ? [block.update] : [])
  if (!tools.length) return undefined

  const reads = new Set<string>()
  const edits = new Set<string>()
  const creates = new Set<string>()
  let searches = 0
  let runs = 0
  let fetches = 0
  let other = 0

  for (const update of tools) {
    if (update.tool === "read") {
      const path = pickToolPath(update)
      if (path) reads.add(path)
      else other++
      continue
    }
    if (update.tool === "edit") {
      const path = pickToolPath(update)
      if (path) (update.input?.oldString === "" ? creates : edits).add(path)
      else other++
      continue
    }
    if (update.tool === "write") {
      const path = pickToolPath(update)
      const exists = update.metadata?.exists !== false
      if (path) (exists ? edits : creates).add(path)
      else other++
      continue
    }
    if (update.tool === "apply_patch") {
      const files = Array.isArray(update.metadata?.files) ? update.metadata.files : []
      for (const file of files) {
        if (typeof file !== "object" || file === null) continue
        const record = file as Record<string, unknown>
        if (typeof record.relativePath !== "string") continue
        if (record.type === "add") creates.add(record.relativePath)
        else if (record.type === "delete") edits.add(record.relativePath)
        else edits.add(record.relativePath)
      }
      continue
    }
    if (update.tool === "grep" || update.tool === "glob") { searches++; continue }
    if (update.tool === "bash") { runs++; continue }
    if (update.tool === "webfetch") { fetches++; continue }
    other++
  }

  const parts: string[] = []
  if (reads.size) parts.push(`Read ${reads.size}`)
  if (creates.size) parts.push(`Created ${creates.size}`)
  if (edits.size) parts.push(`Edited ${edits.size}`)
  if (searches) parts.push(`${searches} ${searches === 1 ? "search" : "searches"}`)
  if (runs) parts.push(`${runs} ${runs === 1 ? "command" : "commands"}`)
  if (fetches) parts.push(`${fetches} ${fetches === 1 ? "fetch" : "fetches"}`)
  if (!parts.length && other) parts.push(`${other} ${other === 1 ? "tool" : "tools"}`)
  return parts.length ? parts.join(" · ") : undefined
}

export function pickToolPath(update: { input?: Record<string, unknown>; title?: string; tool: string }): string | undefined {
  if (typeof update.input?.filePath === "string") return update.input.filePath
  if (typeof update.input?.path === "string") return update.input.path
  if (update.title) return update.title
  return undefined
}

export function textTitle(text: string) {
  const [first = ""] = text.trim().split(/\n+/)
  const title = cleanProcessText(first).replace(/[:.]+$/, "")
  if (!title || title.length > 80) return undefined
  if (/^(i('|’)m|i am|i need|i think|it seems|this|the user|found|next|now)\b/i.test(title)) return undefined
  if (title.split(/\s+/).length > 8) return undefined
  return title
}

export function stripDuplicateTitle(text: string, title: string) {
  const lines = text.trim().split(/\n+/)
  if (cleanProcessText(lines[0] ?? "").replace(/[:.]+$/, "") === title) {
    return lines.slice(1).join("\n").trim()
  }
  return text.trim()
}

export function cleanProcessText(text: string) {
  return text
    .trim()
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^__(.+)__$/, "$1")
    .replace(/^#+\s*/, "")
}

/**
 * Strip internal scaffolding markers that the model or harness inserts into
 * its reasoning/text stream (system reminders, internal comments). These are
 * not user-facing content and shouldn't render in the chat conversation.
 */
export function stripInternalMarkers(text: string): string {
  return text
    // <system-reminder>...</system-reminder> (often multi-line; non-greedy)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    // Stray opening/closing tags left over from partial streams.
    .replace(/<\/?system-reminder>/gi, "")
    // HTML-style internal comments (e.g. <!-- OMO_INTERNAL_INITIATOR -->).
    .replace(/<!--[\s\S]*?-->/g, "")
    // <command-name>, <command-message>, <command-args>, <local-command-stdout>
    // and similar harness scaffolding tags.
    .replace(/<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|user-prompt-submit-hook)>[\s\S]*?<\/\1>/gi, "")
    // Collapse the blank lines left behind by removed blocks.
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "")
}

export function inferredTextTitle(text: string) {
  const value = text.trim()
  if (/^i detect\b/i.test(value)) return "Understanding request"
  if (/^found\b/i.test(value)) return "Inspecting project"
  if (/^next\b/i.test(value)) return "Planning next step"
  if (/^i[’']ve confirmed\b/i.test(value)) return "Reviewing structure"
  if (/^i[’']ve got\b/i.test(value)) return "Reviewing findings"
  if (/\bchecking\b/i.test(value)) return "Checking project"
  if (/\breading\b/i.test(value)) return "Reading files"
  if (/\binspecting\b/i.test(value)) return "Inspecting code"
  if (/\bexploring\b/i.test(value)) return "Exploring project"
  if (/\bconsidering\b/i.test(value)) return "Considering next step"
  return undefined
}

