import { Fragment, memo, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { RetryStatus } from "./RetryStatus"
import { useSweepPhase } from "../hooks/useLivePhase"
import type { Block, Message } from "../hooks/useChatState"
import type { Attachment, ConversationMention, ConversationSummary, DirEntry, FileSearchHit, SessionRetryInfo } from "../protocol"
import { findTokenRanges, makeAttachmentLabel } from "../mention-tokens"
import {
  answerStartIndex,
  firstLineSettled,
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
import { formatElapsed, ToolTrace } from "./ToolCard"
import { agentsNote } from "../agent-row"
import { AgentTasksContext, TurnContext, TurnStartContext } from "../trace-context"
import { ICON_SIZE } from "../design-tokens"
import { sameUsage, usageBreakdown, usageDetail, usageSummary, type UsageRow } from "../usage-format"

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
  /** What the whole turn used, given to its last reply: the chip shows the turn, not its last step (#792). */
  turnUsage?: Message["usage"]
  onReviewFile?: (path: string) => void
  onEditMessage?: (id: string, text: string, mentions?: string[], attachments?: Attachment[], conversationMentions?: ConversationMention[]) => void
  onBeginEdit?: (id: string) => void
  onEndEdit?: (id: string) => void
  onRetry?: (assistantID: string) => void
  /** Provider retry opencode is waiting on; rendered in place of the thinking indicator (#611). */
  retry?: SessionRetryInfo
  searchFiles?: (query: string) => Promise<FileSearchHit[]>
  listDir?: (path: string) => Promise<DirEntry[]>
  attachFile?: () => Promise<{ attachments: Attachment[]; error?: string }>
  conversations?: ConversationSummary[]
  activeConversationID?: string
  onOpenLink?: (url: string) => void
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
    sameUsage(prev.turnUsage, next.turnUsage) &&
    prev.retry === next.retry &&
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
  turnUsage,
  onReviewFile,
  onEditMessage,
  onBeginEdit,
  onEndEdit,
  onRetry,
  retry,
  searchFiles,
  listDir,
  attachFile,
  conversations,
  activeConversationID,
  onOpenLink,
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
        onOpenLink={onOpenLink}
      />
    )
  }
  // opencode's compaction turn (AssistantMessage.summary): the raw summary
  // text is internal bookkeeping, so it collapses to a marker instead of
  // rendering as a normal reply. Stopped/errored compactions fall through to
  // the regular bubble — an interrupted compaction is not a completed one.
  if (message.summary && !message.error && !message.stopped) {
    return <CompactionMarker message={message} onReviewFile={onReviewFile} />
  }
  return (
    <div className={`msg role-${message.role}`}>
      {message.ref?.label && <div className="msg-ref">{message.ref.label}</div>}
      <TurnScope message={message}>{renderMessageBlocks(message, processOpen, processOnly, onReviewFile, !retry)}</TurnScope>
      {retry && message.pending && <RetryStatus retry={retry} onOpenLink={onOpenLink} />}
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
        Show the per-message usage chip only when (a) the chat is idle
        overall (`busy === false`) AND (b) this isn't an intermediate
        sub-task panel (`processOnly === false`). Hephaestus-style agents
        emit multi-step turns where every finished sub-task carries its own
        usage; rendering them mid-flight makes "done" artefacts sit next to
        the still-running ProcessPanel and the chat looks both finished and
        working at the same time. Once the conversation settles, the chips
        all appear at once for review.
      */}
      {!busy && !processOnly && (turnUsage ?? message.usage) && <UsageChip usage={(turnUsage ?? message.usage)!} />}
    </div>
  )
}

/**
 * One figure at rest, the full breakdown in an overlay on hover or focus.
 * The detail is an overlay rather than an inline expansion so the message
 * never changes height under the pointer (#656). It is a real element laid
 * out as labelled rows rather than a data-tooltip pseudo-element (#742); the
 * chip's label carries the same rows as text, so the overlay is hidden from
 * assistive tech.
 */
function UsageChip({ usage }: { usage: NonNullable<Message["usage"]> }) {
  const chipRef = useRef<HTMLSpanElement>(null)
  const popoverRef = useRef<HTMLSpanElement>(null)
  const [below, setBelow] = useState(false)
  const summary = usageSummary(usage)
  if (!summary) return null
  const { model, totals, kinds } = usageBreakdown(usage)
  // The overlay opens upward, where the scroller's top edge would clip it
  // under the first short reply of a conversation; the empty transcript
  // below has the room then. Measured on each reveal because the chip's
  // place in the scroller changes as the transcript grows.
  const place = () => {
    const chip = chipRef.current
    const popover = popoverRef.current
    if (!chip || !popover) return
    const scroller = chip.closest(".messages")
    const room = chip.getBoundingClientRect().top - (scroller?.getBoundingClientRect().top ?? 0)
    setBelow(room < popover.offsetHeight + USAGE_POPOVER_GAP)
  }
  return (
    <div className="msg-usage-row">
      <span ref={chipRef} className="msg-usage" role="note" tabIndex={0} aria-label={usageDetail(usage)} onMouseEnter={place} onFocus={place}>
        {summary}
        {totals.length + kinds.length > 0 && (
          <span ref={popoverRef} className={below ? "msg-usage-popover is-below" : "msg-usage-popover"} aria-hidden="true">
            {model && <span className="msg-usage-model">{model}</span>}
            {totals.length > 0 && <UsageRows rows={totals} />}
            {kinds.length > 0 && <UsageRows rows={kinds} className="msg-usage-kinds" />}
          </span>
        )}
      </span>
    </div>
  )
}

/** The gap between the chip and its overlay, as `.msg-usage-popover` sets it. */
const USAGE_POPOVER_GAP = 6

function UsageRows({ rows, className }: { rows: UsageRow[]; className?: string }) {
  return (
    <span className={className ? `msg-usage-table ${className}` : "msg-usage-table"}>
      {rows.map((row) => (
        <Fragment key={row.label}>
          <span className="msg-usage-label">{row.label}</span>
          <span className="msg-usage-value">{row.value}</span>
        </Fragment>
      ))}
    </span>
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
  onOpenLink,
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
  onOpenLink?: (url: string) => void
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
  // first send — host resolves restored attachments via storageID / dataUrl).
  const initialAttachments: Attachment[] = attachmentBlocks.map((block, i) => ({
    id: `att_${message.id}_${i}`,
    mime: block.mime,
    filename: block.filename,
    dataUrl: block.dataUrl,
    bytes: block.bytes,
    storageID: block.storageID,
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
            onOpenLink={onOpenLink}
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
            <div className="user-text">{renderUserText(originalText, knownLabels)}</div>
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
        src={previewImage?.dataUrl ? { dataUrl: previewImage.dataUrl, filename: previewImage.filename } : null}
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
 * spans and http(s) URLs in real anchors, mirroring the in-editor styling so
 * the rendered user bubble reads as the same content the user composed.
 * target="_blank" for the same reason as Markdown.tsx's anchor override: the
 * webview swallows same-tab navigations, so a plain href would look dead.
 */
export function renderUserText(text: string, knownLabels: Set<string>): ReactNode[] {
  const ranges = findTokenRanges(text, knownLabels)
  if (ranges.length === 0) return [text]
  const out: ReactNode[] = []
  let cursor = 0
  for (const r of ranges) {
    if (r.start > cursor) out.push(text.slice(cursor, r.start))
    if (r.kind === "link") {
      out.push(
        <a
          key={r.start}
          className="user-link"
          href={r.url}
          target="_blank"
          rel="noreferrer noopener"
          // The surrounding .msg.role-user listens for click-to-edit; without
          // this, opening a link also flips the bubble into edit mode.
          onClick={(e) => e.stopPropagation()}
        >
          {text.slice(r.start, r.end)}
        </a>,
      )
    } else {
      out.push(
        <span key={r.start} className="mention-chip">
          {text.slice(r.start, r.end)}
        </span>,
      )
    }
    cursor = r.end
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  return out
}

/**
 * `placeholder` lets a pending reply with nothing to show yet draw the panel's
 * head alone, titled Thinking: the line is there from the first frame, and
 * the first block opens the same panel instead of replacing a separate
 * element (#798). A provider retry takes that place instead (#611).
 */
function renderMessageBlocks(message: Message, processOpen: boolean, processOnly: boolean, onReviewFile?: (path: string) => void, placeholder = true) {
  if (message.role !== "assistant") return renderBlocks(message.blocks, false, onReviewFile)
  const pending = Boolean(message.pending)
  const waiting = pending && placeholder
  if (processOnly) {
    if (!hasProcessBlocks(message.blocks) && !waiting) return null
    return <ProcessPanel blocks={message.blocks} pending={pending} openKey={`process-only-${message.id}`} defaultOpen={processOpen} onReviewFile={onReviewFile} />
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

  // One shape for every phase of the turn: the panel slot, then the answer
  // slot. The boundary moves on every tool call, and alternating between a
  // bare panel and a fragment at this slot made React remount the panel
  // (and re-parse and re-highlight everything open inside it) at each flip.
  // A null panel keeps the slot, so a text-only reply still has none (#601).
  let panel: ReactNode = null
  let answerBlocks = answer
  if (answerHasText) {
    if (hasProcessBlocks(process)) {
      panel = <ProcessPanel blocks={process} pending={false} openKey={`final-${message.id}`} defaultOpen={false} onReviewFile={onReviewFile} />
    }
  } else if (hasProcessBlocks(message.blocks) || waiting) {
    // Ends on activity/reasoning — no distinct answer to surface yet, so the
    // whole message is the live process.
    panel = <ProcessPanel blocks={message.blocks} pending={pending} openKey={`process-${message.id}`} defaultOpen={processOpen} onReviewFile={onReviewFile} />
    answerBlocks = []
  }
  return (
    <>
      {panel}
      {renderBlocks(answerBlocks, false, onReviewFile, pending)}
    </>
  )
}

/** Tells the agent rows inside whether this message is still being written and whether the user stopped it (#796). */
function TurnScope({ message, children }: { message: Message; children: ReactNode }) {
  const live = Boolean(message.pending)
  const stopped = Boolean(message.stopped) || /^aborted$/i.test(message.error ?? "")
  const turn = useMemo(() => ({ live, stopped }), [live, stopped])
  return <TurnContext.Provider value={turn}>{children}</TurnContext.Provider>
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
  // Lazy mount: nothing renders inside a never-opened body — a long
  // transcript's collapsed tool traces and process text would otherwise all
  // render invisibly. Once opened it stays mounted so the 0fr fold
  // animation has content during collapse.
  const [everOpened, setEverOpened] = useState(defaultOpen)

  // The reset tracks the panel's phase (live work, final summary) and the
  // active message, never the block count: keyed on the count, every tool
  // call reopened a live panel the user had just folded.
  useEffect(() => {
    setOpen(defaultOpen)
    if (defaultOpen) setEverOpened(true)
  }, [defaultOpen, openKey])

  const toggle = () => {
    if (!open) setEverOpened(true)
    setOpen(!open)
  }

  // Nothing to open yet: the head stands alone as the reply's first line (#798).
  const bare = !hasProcessBlocks(blocks)
  const headline = processTitle(blocks, pending)
  const summary = pending ? undefined : processSummary(blocks)
  const title = summary ?? headline.title
  // A live block that is folded hides its agents' rows; its head says how many are at work (#796).
  const tasks = useContext(AgentTasksContext)
  const agents = pending && !open ? agentsNote(tasks) : undefined
  // The head shows that block's first line, so the body carries only the rest.
  const headlined = summary === undefined ? headline.source : -1
  const since = useContext(TurnStartContext)

  return (
    <div
      className={`process${open && !bare ? " is-open" : ""}${bare ? " is-bare" : ""}${pending ? " is-live" : ""}`}
      role={bare ? "status" : undefined}
      aria-label={bare ? "Thinking" : undefined}
    >
      {/* One element whether or not there is a body, so the words keep their
          place and can change in place when the first block arrives. */}
      <button className="process-head" onClick={toggle} aria-expanded={bare ? undefined : open} disabled={bare}>
        <TitleSwap text={title} live={pending} />
        {agents && <span className={`process-agents${agents.waiting ? " is-waiting" : ""}`}>{agents.text}</span>}
        {!bare && <span className={`process-caret ${open ? "is-open" : ""}`}>›</span>}
        {pending && since !== undefined && <TurnElapsed since={since} />}
      </button>
      {/* The clip wrapper stays mounted; the grid clips it to 0fr when
          collapsed so expand/collapse animates height instead of snapping. */}
      <div className="process-body-clip">
        <div className="process-body">{everOpened && !bare ? renderBlocks(blocks, true, onReviewFile, pending, headlined) : null}</div>
      </div>
    </div>
  )
}

/** A quick reply never shows a counter; past this the live line says how long the turn has run. */
const TURN_ELAPSED_GRACE_MS = 3000

/**
 * The turn's running time on the live line (#798). It ticks on the turn's own
 * second boundaries, so the figure does not hiccup when a new step's line
 * takes over from the last one's.
 */
function TurnElapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let handle = 0
    const wait = () => {
      handle = window.setTimeout(() => {
        setNow(Date.now())
        wait()
      }, 1000 - ((Date.now() - since) % 1000))
    }
    wait()
    return () => window.clearTimeout(handle)
  }, [since])
  const elapsed = now - since
  if (elapsed < TURN_ELAPSED_GRACE_MS) return null
  // It fades in the one time it appears; a later step's line starts with it there.
  const entering = elapsed < TURN_ELAPSED_GRACE_MS + 1000
  return <span className={`process-elapsed${entering ? " is-entering" : ""}`}>{formatElapsed(elapsed)}</span>
}

/** How long the old words stay drawn; a little past their 140 ms exit in styles.css. */
const TITLE_LEAVE_MS = 200

/**
 * The head's words. When they change, the old ones leave upward while the new
 * ones arrive from below, inside the row's own height (#798). The old words
 * are drawn from an attribute, not as text: they are no longer content, so a
 * selection does not copy them and nothing that reads the title sees two.
 */
function TitleSwap({ text, live }: { text: string; live: boolean }) {
  const [shown, setShown] = useState({ text, changes: 0 })
  const [leaving, setLeaving] = useState<string | null>(null)
  if (text !== shown.text) {
    setShown({ text, changes: shown.changes + 1 })
    setLeaving(shown.text)
  }
  useEffect(() => {
    if (leaving === null) return
    const handle = window.setTimeout(() => setLeaving(null), TITLE_LEAVE_MS)
    return () => window.clearTimeout(handle)
  }, [leaving, shown.changes])
  // While the reply is pending a light crosses the words (styles.css).
  const phase = useSweepPhase(live, shown.changes)
  return (
    <span className="process-title process-title-swap">
      {leaving !== null && <span key={`out-${shown.changes}`} className="process-title-out" data-text={leaving} aria-hidden="true" />}
      <span
        key={shown.changes}
        className={`process-title-text${shown.changes ? " is-entering" : ""}`}
        style={phase}
      >
        {text}
      </span>
    </span>
  )
}

const NO_BLOCKS: Block[] = []

/**
 * The line that stands for a reply the server has not opened yet, so a sent
 * prompt is answered at once (#798). It is the head a pending reply starts
 * with, in the same place, so the reply taking over changes nothing on screen.
 */
export function PendingReply() {
  return (
    <div className="msg role-assistant pending-reply">
      <ProcessPanel blocks={NO_BLOCKS} pending openKey="pending-reply" defaultOpen={false} />
    </div>
  )
}

/**
 * The compaction summary rendered in the same visual idiom as tool traces
 * and the process panel (shared `process-*` classes), so it reads as one of
 * the turn's collapsible work rows rather than a callout box. Unlike
 * ProcessPanel there is no openKey/defaultOpen churn: it starts collapsed
 * and stays wherever the user toggled it.
 */
function CompactionMarker({ message, onReviewFile }: { message: Message; onReviewFile?: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  // Same lazy-mount latch as ProcessPanel: the summary body only renders
  // once the user first expands the marker.
  const [everOpened, setEverOpened] = useState(false)
  const toggle = () => {
    if (!open) setEverOpened(true)
    setOpen(!open)
  }
  const label = message.pending ? "Compacting conversation…" : "Conversation compacted"
  return (
    <div className={`process compaction-marker ${open ? "is-open" : ""}`}>
      <button className="process-head" onClick={toggle} aria-expanded={open}>
        <span className="process-title">{label}</span>
        <span className={`process-caret ${open ? "is-open" : ""}`}>›</span>
      </button>
      <div className="process-body-clip">
        <div className="process-body">
          {everOpened ? renderBlocks(message.blocks, true, onReviewFile, Boolean(message.pending)) : null}
        </div>
      </div>
    </div>
  )
}

function renderBlocks(blocks: Block[], processMode = false, onReviewFile?: (path: string) => void, streaming = false, headlined = -1) {
  const nodes: ReactNode[] = []
  let tools: Extract<Block, { type: "tool" }>[] = []
  let patches: Extract<Block, { type: "patch" }>[] = []
  const flushTrace = () => {
    if (!tools.length && !patches.length) return
    nodes.push(
      <ToolTrace key={`trace-${nodes.length}`} tools={tools} patches={patches} onReviewFile={onReviewFile} />,
    )
    tools = []
    patches = []
  }
  const last = blocks.length - 1
  blocks.forEach((b, i) => {
    // Deltas append to the last block, so only that one is still growing.
    const live = streaming && i === last
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
        if (cleaned.trim()) {
          nodes.push(<ProcessText key={i} text={cleaned} streaming={live} settled={!live || firstLineSettled(b.text)} inHead={i === headlined} />)
        }
      } else {
        const segments = splitWithReminders(b.text)
        segments.forEach((seg, j) => {
          const key = `${i}-${j}`
          if (seg.type === "reminder") {
            nodes.push(<SystemReminderCallout key={key} text={seg.content} />)
          } else {
            nodes.push(<Markdown key={key} text={seg.content} streaming={live} />)
          }
        })
      }
    }
    if (b.type === "reasoning") {
      const cleaned = stripInternalMarkers(b.text)
      if (!cleaned.trim()) return
      nodes.push(<ProcessText key={i} text={cleaned} streaming={live} settled={!live || firstLineSettled(b.text)} inHead={i === headlined} />)
    }
  })
  flushTrace()
  return nodes
}

/**
 * `settled` says the first line may be read as a title (a live block's line
 * is still being typed until a newline closes it); `inHead` says the panel
 * head already shows that title, so the body carries only what follows it.
 */
function ProcessText({
  text,
  streaming = false,
  settled = true,
  inHead = false,
}: {
  text: string
  streaming?: boolean
  settled?: boolean
  inHead?: boolean
}) {
  if (!text.trim()) return null
  const title = settled ? textTitle(text) : undefined
  if (!title) return <div className="process-text"><Markdown text={text} streaming={streaming} /></div>
  const body = stripDuplicateTitle(text, title)
  if (inHead && !body) return null
  return (
    <div className="process-text">
      {!inHead && <div className="process-text-title">{title}</div>}
      {body && <Markdown text={body} streaming={streaming} />}
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
