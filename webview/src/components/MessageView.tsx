import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import type { Block, Message } from "../hooks/useChatState"
import type { AgentsStatusInfo, Attachment, FileSearchHit } from "../protocol"
import { findMentionRanges, makeAttachmentLabel } from "../mention-tokens"
import { ImagePreviewModal } from "./ImagePreviewModal"
import { ImageThumbnail, type Thumbnailable } from "./ImageThumbnail"
import { Markdown } from "./Markdown"
import { PromptBox } from "./PromptBox"
import { ToolTrace, toolHeadline } from "./ToolCard"
import { ICON_SIZE } from "../design-tokens"
import { AgentActivity } from "./AgentActivity"

/**
 * Discriminated edit lifecycle for user-message bubbles.
 *
 * - `view`     — read-only; hover/focus affordances are enabled here ONLY.
 * - `editing`  — overlay rendered, border-in animation, click-outside cancels.
 *
 * One value drives both the JSX (`data-edit-phase` attribute on the row) and
 * the CSS (selectors keyed on that attribute). Previously this lifecycle was
 * three booleans + a `setTimeout` that had to stay in lockstep with CSS.
 * The state machine collapses them into a single source of truth so the
 * visual state can never be the *combination* of overlapping boolean flags.
 */
type EditPhase = "view" | "editing"

export function MessageView({
  message,
  processOpen,
  processOnly,
  busy,
  onReviewFile,
  onEditMessage,
  onBeginEdit,
  onEndEdit,
  onRetry,
  agentActivity,
  searchFiles,
  attachFile,
}: {
  message: Message
  processOpen: boolean
  processOnly: boolean
  busy?: boolean
  onReviewFile?: (path: string) => void
  onEditMessage?: (id: string, text: string, mentions?: string[], attachments?: Attachment[], conversationMentions?: string[]) => void
  onBeginEdit?: (id: string) => void
  onEndEdit?: (id: string) => void
  onRetry?: (assistantID: string) => void
  agentActivity?: AgentsStatusInfo
  searchFiles?: (query: string) => Promise<FileSearchHit[]>
  attachFile?: () => Promise<{ attachments: Attachment[]; error?: string }>
}) {
  if (message.role === "user") {
    return (
      <UserMessageView
        message={message}
        busy={busy}
        onEditMessage={onEditMessage}
        onBeginEdit={onBeginEdit}
        onEndEdit={onEndEdit}
        searchFiles={searchFiles}
        attachFile={attachFile}
      />
    )
  }
  return (
    <div className={`msg role-${message.role}`}>
      {message.ref?.label && <div className="msg-ref">{message.ref.label}</div>}
      {renderMessageBlocks(message, processOpen, processOnly, onReviewFile)}
      <AgentActivity status={agentActivity} />
      {message.pending && message.blocks.length === 0 && (
        <div className="thinking-dots" role="status" aria-label="Thinking">thinking</div>
      )}
      {(() => {
        // Stopped state overrides error: a message can carry both
        //   1) the new `stopped: true` flag (set by my reducer fix), OR
        //   2) an `error: "Aborted"` string persisted from older sessions
        //      that ran before the abort fix shipped.
        // In either case render ONE neutral grey "Stopped" badge, not the red
        // error block. Real failures (network, etc.) still render in red.
        const stopped = message.stopped || /^aborted$/i.test((message.error ?? "").trim())
        if (stopped) {
          return (
            <div className="msg-stopped">
              <span>Stopped</span>
              {onRetry && !busy && (
                <button
                  type="button"
                  className="msg-retry"
                  onClick={() => onRetry(message.id)}
                  title="Resend the same prompt"
                >
                  Retry
                </button>
              )}
            </div>
          )
        }
        if (message.error) return <div className="msg-error">{message.error}</div>
        return null
      })()}
      {/*
        Show the per-message `model · cost · tokens` line only when (a) the
        chat is idle overall (`busy === false`) AND (b) this isn't an
        intermediate sub-task panel (`processOnly === false`). Hephaestus-
        style agents emit multi-step turns where every finished sub-task
        carries its own usage; rendering them mid-flight makes "done"
        artefacts sit next to the still-running ProcessPanel and the chat
        looks both finished and working at the same time. Once the
        conversation settles, the usage lines all appear at once for
        review.
      */}
      {!busy && !processOnly && (message.usage?.model || message.usage?.cost || message.usage?.tokens) && (
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
  onBeginEdit,
  onEndEdit,
  searchFiles,
  attachFile,
}: {
  message: Message
  busy?: boolean
  onEditMessage?: (id: string, text: string, mentions?: string[], attachments?: Attachment[], conversationMentions?: string[]) => void
  onBeginEdit?: (id: string) => void
  onEndEdit?: (id: string) => void
  searchFiles?: (query: string) => Promise<FileSearchHit[]>
  attachFile?: () => Promise<{ attachments: Attachment[]; error?: string }>
}) {
  const originalText = message.blocks
    .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
  const attachmentBlocks = message.blocks.filter(
    (b): b is Extract<Block, { type: "attachment" }> => b.type === "attachment",
  )
  const [editPhase, setEditPhase] = useState<EditPhase>("view")
  const [editPlaceholderHeight, setEditPlaceholderHeight] = useState<number | null>(null)
  const [previewImage, setPreviewImage] = useState<Thumbnailable | null>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const editAreaRef = useRef<HTMLDivElement>(null)

  const exitEditing = () => {
    if (editPhase !== "editing") return
    setEditPhase("view")
    setEditPlaceholderHeight(null)
    onEndEdit?.(message.id)
  }

  // Click-outside cancels the edit. We listen on the document so any click
  // outside the editing container — anywhere in the chat panel — drops us
  // back to view mode. Cheap and matches the "no Cancel button" UX.
  useEffect(() => {
    if (editPhase !== "editing") return
    const onPointerDown = (event: PointerEvent) => {
      if (editAreaRef.current?.contains(event.target as Node)) return
      exitEditing()
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [editPhase, message.id, onEndEdit])

  // Re-derive attachment labels (same algorithm PromptBox originally used) and
  // wrap each attachment block into the Attachment shape, including a synthetic
  // id and an undefined sourcePath (the original file path is lost after the
  // first send — host falls back to the dataUrl for restored attachments).
  const initialAttachments: Attachment[] = attachmentBlocks.map((block, i) => ({
    id: `att_${message.id}_${i}`,
    mime: block.mime,
    filename: block.filename,
    dataUrl: block.dataUrl,
    bytes: block.bytes,
  }))
  const knownLabels: Set<string> = (() => {
    const existing = new Set<string>(message.mentions ?? [])
    for (const a of attachmentBlocks) {
      existing.add(makeAttachmentLabel(a.filename, new Set(existing)))
    }
    return existing
  })()

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

  const handleSubmit = (text: string, mentions?: string[], attachments?: Attachment[], conversationMentions?: string[]) => {
    const trimmed = text.trim()
    if (!trimmed && !attachments?.length) return
    const sameText = trimmed === originalText.trim()
    const sameMentionCount = (mentions?.length ?? 0) === (message.mentions?.length ?? 0)
    const sameAttachCount = (attachments?.length ?? 0) === attachmentBlocks.length
    if (sameText && sameMentionCount && sameAttachCount) {
      exitEditing()
      return
    }
    onEditMessage?.(message.id, trimmed, mentions, attachments, conversationMentions)
    exitEditing()
  }

  const enterEditing = () => {
    if (!editable) return
    if (editPhase === "editing") return
    if (typeof window !== "undefined" && window.getSelection?.()?.toString()) return
    onBeginEdit?.(message.id)
    setEditPlaceholderHeight(bubbleRef.current?.getBoundingClientRect().height ?? null)
    setEditPhase("editing")
  }

  const inEditMode = editPhase !== "view"

  return (
    <div
      ref={bubbleRef}
      className={`msg role-user ${editable ? "is-editable" : ""}`}
      data-edit-phase={editPhase}
      style={inEditMode && editPlaceholderHeight
        ? ({ "--edit-placeholder-height": `${editPlaceholderHeight}px` } as CSSProperties)
        : undefined}
      onClick={enterEditing}
      role={editable && !inEditMode ? "button" : undefined}
      tabIndex={editable && !inEditMode ? 0 : undefined}
      onKeyDown={editable && !inEditMode ? (event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          enterEditing()
        }
      } : undefined}
      title={inEditMode ? undefined : editTitle}
    >
      {inEditMode ? (
        <div
          ref={editAreaRef}
          className="user-edit-layer"
          onClick={(event) => event.stopPropagation()}
        >
          {message.ref?.label && <div className="msg-ref">{message.ref.label}</div>}
          <PromptBox
            busy={false}
            onSend={handleSubmit}
            onAbort={exitEditing}
            searchFiles={searchFiles}
            attachFile={attachFile}
            variant="edit"
            initial={{
              text: originalText,
              mentions: message.mentions,
              attachments: initialAttachments,
              conversationMentions: message.conversationMentions,
            }}
          />
        </div>
      ) : (
        <>
          {message.ref?.label && <div className="msg-ref">{message.ref.label}</div>}
          {attachmentBlocks.length > 0 && (
            <ul className="msg-attachments" aria-label="Attachments">
              {attachmentBlocks.map((a, i) =>
                a.mime.startsWith("image/") ? (
                  // Image attachments render as a bare thumbnail — matches
                  // the prompt-box strip. ImageThumbnail's open-button
                  // stopPropagations so previewing doesn't also flip the
                  // bubble into edit mode (the surrounding `.msg.role-user`
                  // listens for click-to-edit). No `onRemove` here — the
                  // sent bubble is read-only.
                  <ImageThumbnail key={i} attachment={a} onPreview={setPreviewImage} />
                ) : (
                  <li key={i} className="attachment-tile readonly" title={a.filename}>
                    <span className="attachment-icon" aria-hidden>{badgeForFilename(a.filename)}</span>
                    <span className="attachment-name">{a.filename}</span>
                  </li>
                ),
              )}
            </ul>
          )}
          {originalText && (
            <div className="user-text">{renderMentionedText(originalText, knownLabels)}</div>
          )}
          {canEdit && (
            <span className="user-edit-hint" aria-hidden="true">
              <svg viewBox="0 0 16 16" width={ICON_SIZE.md} height={ICON_SIZE.md} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8h7a3 3 0 0 1 0 6H6.5"/>
                <polyline points="5.5,5 3,8 5.5,11"/>
              </svg>
            </span>
          )}
        </>
      )}
      <ImagePreviewModal
        src={previewImage ? { dataUrl: previewImage.dataUrl, filename: previewImage.filename } : null}
        onClose={() => setPreviewImage(null)}
      />
    </div>
  )
}

/**
 * Choose a short badge label for a non-image attachment. PDF stays "PDF";
 * everything else falls back to the file's uppercase extension, capped at
 * 4 chars so the badge stays compact in the message bubble. Some longer
 * canonical extensions are abbreviated by hand.
 */
function badgeForFilename(filename: string): string {
  const dot = filename.lastIndexOf(".")
  if (dot < 0) return "FILE"
  const ext = filename.slice(dot + 1).toLowerCase()
  if (!ext) return "FILE"
  const aliases: Record<string, string> = {
    markdown: "MD",
    javascript: "JS",
    typescript: "TS",
    yaml: "YML",
    python: "PY",
  }
  if (aliases[ext]) return aliases[ext]
  if (ext === "pdf") return "PDF"
  return ext.length <= 4 ? ext.toUpperCase() : ext.slice(0, 4).toUpperCase()
}

/**
 * Wrap @path tokens (whose target is in `knownLabels`) in `.mention-chip`
 * spans, mirroring the in-editor chip styling so the rendered user bubble
 * reads as the same content the user composed.
 */
export function renderMentionedText(text: string, knownLabels: Set<string>): ReactNode[] {
  if (knownLabels.size === 0) return [text]
  const ranges = findMentionRanges(text, knownLabels)
  if (ranges.length === 0) return [text]
  const out: ReactNode[] = []
  let cursor = 0
  for (const r of ranges) {
    if (r.start > cursor) out.push(text.slice(cursor, r.start))
    out.push(
      <span key={r.start} className="mention-chip">
        {text.slice(r.start, r.end)}
      </span>,
    )
    cursor = r.end
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  return out
}

function renderMessageBlocks(message: Message, processOpen: boolean, processOnly: boolean, onReviewFile?: (path: string) => void) {
  if (message.role !== "assistant") return renderBlocks(message.blocks, false, onReviewFile)
  const pending = Boolean(message.pending)
  if (processOnly) {
    if (!hasProcessBlocks(message.blocks)) return null
    return <ProcessPanel blocks={message.blocks} pending={pending} openKey={`process-only-${message.id}-${message.blocks.length}`} defaultOpen={processOpen} onReviewFile={onReviewFile} />
  }

  const finalTextIndex = lastTextIndex(message.blocks, Boolean(message.pending))
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
      // Hephaestus and other deep agents sometimes emit "system-reminder"
      // as a synthetic tool block instead of as an inline `<system-reminder>`
      // text tag. The generic tool trace renders that with the literal
      // tool name as the title (e.g. `<system-reminder> ›`) and the
      // reminder content stuck inside the trace's expand-to-see body.
      // Surface it as the same collapsible callout used for the inline
      // form — open by default — or strip entirely when we're already
      // inside the trace panel.
      if (isSystemReminderTool(b.update.tool)) {
        flushTrace()
        if (!processMode) {
          const text = systemReminderContentFromTool(b.update)
          if (text) nodes.push(<SystemReminderCallout key={`tool-reminder-${i}`} text={text} />)
        }
        return
      }
      tools.push(b)
      return
    }
    if (b.type === "patch") {
      patches.push(b)
      return
    }
    flushTrace()
    if (b.type === "text") {
      // In processMode (within the trace panel) we still strip reminders —
      // they'd nest inside already-collapsed UI and be noise. In normal
      // rendering, surface them as collapsible callouts.
      if (processMode) {
        const cleaned = stripInternalMarkers(b.text)
        if (cleaned.trim()) nodes.push(<ProcessText key={i} text={cleaned} />)
      } else {
        const segments = splitWithReminders(b.text)
        segments.forEach((seg, j) => {
          const key = `${i}-${j}`
          if (seg.type === "reminder") {
            nodes.push(<SystemReminderCallout key={key} text={seg.content} />)
          } else {
            nodes.push(<Markdown key={key} text={seg.content} />)
          }
        })
      }
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
  if (!title) return <div className="process-text"><Markdown text={text} /></div>
  const body = stripDuplicateTitle(text, title)
  return (
    <div className="process-text">
      <div className="process-text-title">{title}</div>
      {body && <Markdown text={body} />}
    </div>
  )
}

export function hasProcessBlocks(blocks: Block[]) {
  return blocks.some((b) => {
    if (b.type === "text" || b.type === "reasoning") {
      // Treat blocks that are *only* internal scaffolding (e.g. a single
      // `<system-reminder>` callout with no other prose) as empty for the
      // purpose of deciding whether to wrap them in a ProcessPanel. Without
      // this guard, a message that is just a reminder ends up wrapped in
      // a panel whose title is the literal `<system-reminder>` first line
      // and whose body collapses to nothing in processMode rendering.
      if (b.type === "reasoning") return stripInternalMarkers(b.text).trim().length > 0
      // For text blocks we strip the noise markers but keep reminder text —
      // those still render as inline callouts inside the panel.
      return splitWithReminders(b.text).length > 0
    }
    if (b.type === "attachment") return false
    if (b.type === "tool") {
      // Tool blocks for synthetic system-reminders aren't real activity;
      // skip them too so an all-reminder message doesn't get wrapped.
      return !isSystemReminderTool(b.update.tool)
    }
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
  const fromText = blocks.flatMap((block) => {
    if (block.type !== "text" && block.type !== "reasoning") return []
    // Strip `<system-reminder>` / command-name / HTML-comment scaffolding
    // BEFORE picking a title — otherwise the first line of a reminder-only
    // block leaks through as the literal `<system-reminder>` title.
    const cleaned = stripInternalMarkers(block.text)
    if (!cleaned.trim()) return []
    return [textTitle(cleaned) ?? inferredTextTitle(cleaned)]
  }).find(Boolean)
  if (fromText) return fromText

  // Real tool calls become a tool-headline title; pure system-reminder tool
  // blocks don't count as work and shouldn't drive the headline.
  const tools = blocks.flatMap((block) =>
    block.type === "tool" && !isSystemReminderTool(block.update.tool) ? [block.update] : [],
  )
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
  // Reject literal HTML-like tags (e.g. `<system-reminder>`, `<command-name>`)
  // — these leak in when the model emits raw scaffolding as the first line
  // and would otherwise become the panel's title verbatim.
  if (/^<\/?\w[\w-]*\s*(\s[^>]*)?\/?>$/.test(title)) return undefined
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
    // <system-reminder ...>...</system-reminder> — also accepts attributes.
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, "")
    // Stray opening/closing tags left over from partial streams.
    .replace(/<\/?system-reminder\b[^>]*>/gi, "")
    // HTML-style internal comments (e.g. <!-- OMO_INTERNAL_INITIATOR -->).
    .replace(/<!--[\s\S]*?-->/g, "")
    // <command-name>, <command-message>, <command-args>, <local-command-stdout>
    // and similar harness scaffolding tags.
    .replace(/<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|user-prompt-submit-hook)>[\s\S]*?<\/\1>/gi, "")
    // Collapse the blank lines left behind by removed blocks.
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "")
}

export type RenderSegment = { type: "text"; content: string } | { type: "reminder"; content: string }

/**
 * Like `stripInternalMarkers` but preserves `<system-reminder>` blocks as
 * separate segments so the UI can render them as collapsible callouts
 * (instead of hiding them entirely). Other internal markers (`<!-- ... -->`,
 * command-name etc.) are still stripped — they're noise, not content.
 */
export function splitWithReminders(text: string): RenderSegment[] {
  // Strip noise markers but DO NOT touch <system-reminder> tags yet — we need
  // the closing tags intact to find paired matches.
  const cleanedNoise = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|user-prompt-submit-hook)>[\s\S]*?<\/\1>/gi, "")

  const segments: RenderSegment[] = []
  const regex = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder>/gi
  let cursor = 0
  let match: RegExpExecArray | null
  const pushText = (raw: string) => {
    // Drop any stray unpaired reminder tags from the surrounding text.
    const cleaned = raw
      .replace(/<\/?system-reminder\b[^>]*>/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+|\n+$/g, "")
    if (cleaned.trim()) segments.push({ type: "text", content: cleaned })
  }
  while ((match = regex.exec(cleanedNoise)) !== null) {
    pushText(cleanedNoise.slice(cursor, match.index))
    const reminder = match[1].trim()
    if (reminder) segments.push({ type: "reminder", content: reminder })
    cursor = match.index + match[0].length
  }
  pushText(cleanedNoise.slice(cursor))
  return segments
}

/**
 * Some deep agents (e.g. Hephaestus) emit reminders as a synthetic tool
 * call whose name is some variant of "system-reminder" instead of the
 * inline `<system-reminder>` text tag. Normalize so we catch
 * `system-reminder`, `<system-reminder>`, `system_reminder`,
 * `systemreminder`, regardless of case.
 */
export function isSystemReminderTool(toolName: string | undefined): boolean {
  if (!toolName) return false
  const normalized = toolName.toLowerCase().replace(/[<>_-]/g, "")
  return normalized === "systemreminder"
}

/**
 * Pull the human-readable reminder text out of a `system-reminder` tool
 * call. Tries the common shapes — `output`, then known string keys on
 * `input`, then `title`. Falls back to JSON-stringifying the input
 * object so we never lose information silently.
 */
export function systemReminderContentFromTool(update: {
  output?: string
  input?: Record<string, unknown>
  title?: string
}): string {
  if (typeof update.output === "string" && update.output.trim()) return update.output.trim()
  if (update.input) {
    for (const key of ["text", "content", "message", "reminder", "body", "value"]) {
      const v = update.input[key]
      if (typeof v === "string" && v.trim()) return v.trim()
    }
    const json = JSON.stringify(update.input)
    if (json && json !== "{}") return json
  }
  if (update.title && update.title.trim()) return update.title.trim()
  return ""
}

function SystemReminderCallout({ text }: { text: string }) {
  // `open` so the body shows by default — users still get to fold it via
  // the chevron if they don't want the noise. The first-line preview that
  // sat next to the label is dropped now that the body is always visible
  // (it duplicated the first line of the markdown below).
  return (
    <details className="system-reminder" open>
      <summary className="system-reminder-summary">
        <span className="system-reminder-chevron" aria-hidden>▸</span>
        <span className="system-reminder-label">System reminder</span>
      </summary>
      <div className="system-reminder-body">
        <Markdown text={text} />
      </div>
    </details>
  )
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
