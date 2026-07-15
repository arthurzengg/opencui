import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import type { Block, Message } from "../hooks/useChatState"
import type { AgentsStatusInfo, Attachment, ConversationMention, ConversationSummary, DirEntry, FileSearchHit } from "../protocol"
import { findMentionRanges, makeAttachmentLabel } from "../mention-tokens"
import {
  answerStartIndex,
  hasProcessBlocks,
  isSystemReminderTool,
  processSummary,
  processTitle,
  splitWithReminders,
  stripDuplicateTitle,
  stripInternalMarkers,
  systemReminderContentFromTool,
  textTitle,
} from "../process-text"
import { ImagePreviewModal } from "./ImagePreviewModal"
import { ImageThumbnail, type Thumbnailable } from "./ImageThumbnail"
import { Markdown } from "./Markdown"
import { PromptBox } from "./PromptBox"
import { ToolTrace } from "./ToolCard"
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

type MessageViewProps = {
  message: Message
  processOpen: boolean
  processOnly: boolean
  busy?: boolean
  onReviewFile?: (path: string) => void
  onEditMessage?: (id: string, text: string, mentions?: string[], attachments?: Attachment[], conversationMentions?: ConversationMention[]) => void
  onBeginEdit?: (id: string) => void
  onEndEdit?: (id: string) => void
  onRetry?: (assistantID: string) => void
  agentActivity?: AgentsStatusInfo
  searchFiles?: (query: string) => Promise<FileSearchHit[]>
  listDir?: (path: string) => Promise<DirEntry[]>
  attachFile?: () => Promise<{ attachments: Attachment[]; error?: string }>
  conversations?: ConversationSummary[]
  activeConversationID?: string
}

/**
 * Render-affecting props only. Function props are intentionally excluded —
 * `useChatState` returns fresh closures every render and `App` passes inline
 * arrows, so comparing them would defeat the memo on every keystroke/delta.
 * The reducer preserves object identity for messages it didn't touch
 * (`appendToLastBlock`/`upsertTool` slice the array and replace one index), so
 * `message` identity is a reliable "did this row change" signal — which lets a
 * streaming turn re-render without dragging the whole transcript with it.
 */
export function sameMessageViewProps(prev: MessageViewProps, next: MessageViewProps): boolean {
  return (
    prev.message === next.message &&
    prev.processOpen === next.processOpen &&
    prev.processOnly === next.processOnly &&
    prev.busy === next.busy &&
    prev.agentActivity === next.agentActivity &&
    prev.conversations === next.conversations &&
    prev.activeConversationID === next.activeConversationID
  )
}

export const MessageView = memo(MessageViewComponent, sameMessageViewProps)

function MessageViewComponent({
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
  listDir,
  attachFile,
  conversations,
  activeConversationID,
}: MessageViewProps) {
  if (message.role === "user") {
    return (
      <UserMessageView
        message={message}
        busy={busy}
        onEditMessage={onEditMessage}
        onBeginEdit={onBeginEdit}
        onEndEdit={onEndEdit}
        searchFiles={searchFiles}
        listDir={listDir}
        attachFile={attachFile}
        conversations={conversations}
        activeConversationID={activeConversationID}
      />
    )
  }
  // opencode's compaction turn (AssistantMessage.summary): the raw summary
  // text is internal bookkeeping, so it collapses to a marker instead of
  // rendering as a normal reply. Stopped/errored compactions fall through to
  // the regular bubble — an interrupted compaction is not a completed one.
  if (message.summary && !message.error && !message.stopped) {
    return (
      <details className="compaction-marker">
        <summary className="compaction-marker-summary">
          <span className="compaction-chevron" aria-hidden>▸</span>
          <span className="compaction-label">
            {message.pending ? "Compacting conversation…" : "Conversation compacted"}
          </span>
        </summary>
        <div className="compaction-body">
          {renderMessageBlocks(message, processOpen, processOnly, onReviewFile)}
        </div>
      </details>
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
  listDir,
  attachFile,
  conversations,
  activeConversationID,
}: {
  message: Message
  busy?: boolean
  onEditMessage?: (id: string, text: string, mentions?: string[], attachments?: Attachment[], conversationMentions?: ConversationMention[]) => void
  onBeginEdit?: (id: string) => void
  onEndEdit?: (id: string) => void
  searchFiles?: (query: string) => Promise<FileSearchHit[]>
  listDir?: (path: string) => Promise<DirEntry[]>
  attachFile?: () => Promise<{ attachments: Attachment[]; error?: string }>
  conversations?: ConversationSummary[]
  activeConversationID?: string
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

  const handleSubmit = (text: string, mentions?: string[], attachments?: Attachment[], conversationMentions?: ConversationMention[]) => {
    const trimmed = text.trim()
    if (!trimmed && !attachments?.length) return
    const sameText = trimmed === originalText.trim()
    const sameMentionCount = (mentions?.length ?? 0) === (message.mentions?.length ?? 0)
    const sameConversationCount = (conversationMentions?.length ?? 0) === (message.conversationMentions?.length ?? 0)
    const sameAttachCount = (attachments?.length ?? 0) === attachmentBlocks.length
    if (sameText && sameMentionCount && sameConversationCount && sameAttachCount) {
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
            listDir={listDir}
            attachFile={attachFile}
            conversations={conversations}
            activeConversationID={activeConversationID}
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

  // Deterministic split: the answer is the trailing run of text after the last
  // activity (tool / patch / reasoning). Everything up to and including that
  // activity is process (work + thinking); the trailing text is the answer.
  // Block order already encodes the structure — no prose-pattern guessing, so a
  // short closing line is never buried in the collapsed work panel.
  const start = answerStartIndex(message.blocks)
  const process = message.blocks.slice(0, start)
  const answer = message.blocks.slice(start)
  const answerHasText = answer.some((b) => b.type === "text" && b.text.trim().length > 0)

  if (!answerHasText) {
    // Ends on activity/reasoning (or is empty) — no distinct answer to surface.
    if (!hasProcessBlocks(message.blocks)) return renderBlocks(message.blocks, false, onReviewFile)
    return <ProcessPanel blocks={message.blocks} pending={pending} openKey={`process-${message.id}-${message.blocks.length}`} defaultOpen={processOpen} onReviewFile={onReviewFile} />
  }

  if (!hasProcessBlocks(process)) return renderBlocks(answer, false, onReviewFile)
  return (
    <>
      <ProcessPanel blocks={process} pending={false} openKey={`final-${message.id}-${start}`} defaultOpen={false} onReviewFile={onReviewFile} />
      {renderBlocks(answer, false, onReviewFile)}
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
    <div className={`process ${open ? "is-open" : ""}`}>
      <button className="process-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="process-title">{title}</span>
        <span className={`process-caret ${open ? "is-open" : ""}`}>›</span>
      </button>
      {/* Body stays mounted; the grid wrapper clips it to 0fr when collapsed so
          expand/collapse animates height instead of snapping. */}
      <div className="process-body-clip">
        <div className="process-body">{renderBlocks(blocks, true, onReviewFile)}</div>
      </div>
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
