import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { RetryStatus } from "./RetryStatus"
import { useLivePhase } from "../hooks/useLivePhase"
import type { Block, Message, AgentActivityResult } from "../hooks/useChatState"
import type { AgentsStatusInfo, Attachment, ConversationMention, ConversationSummary, DirEntry, FileSearchHit, SessionRetryInfo } from "../protocol"
import { findTokenRanges, makeAttachmentLabel } from "../mention-tokens"
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
import { usageDetail, usageSummary } from "../usage-format"
import { AgentActivity, formatElapsed } from "./AgentActivity"

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
  agentActivityEntering?: boolean
  /** Loads one agent's transcript for the popover detail view. */
  requestAgentActivity?: (taskID: string) => Promise<AgentActivityResult>
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
    prev.agentActivity === next.agentActivity &&
    prev.agentActivityEntering === next.agentActivityEntering &&
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
  onReviewFile,
  onEditMessage,
  onBeginEdit,
  onEndEdit,
  onRetry,
  agentActivity,
  agentActivityEntering,
  requestAgentActivity,
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
      {renderMessageBlocks(message, processOpen, processOnly, onReviewFile)}
      <AgentActivity status={agentActivity} entering={agentActivityEntering} requestActivity={requestAgentActivity} />
      {retry && message.pending && <RetryStatus retry={retry} onOpenLink={onOpenLink} />}
      {!retry && message.pending && message.blocks.length === 0 && (
        <ThinkingLine quiet={(agentActivity?.total ?? 0) > 0} />
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
        Show the per-message usage chip only when (a) the chat is idle
        overall (`busy === false`) AND (b) this isn't an intermediate
        sub-task panel (`processOnly === false`). Hephaestus-style agents
        emit multi-step turns where every finished sub-task carries its own
        usage; rendering them mid-flight makes "done" artefacts sit next to
        the still-running ProcessPanel and the chat looks both finished and
        working at the same time. Once the conversation settles, the chips
        all appear at once for review.
      */}
      {!busy && !processOnly && message.usage && <UsageChip usage={message.usage} />}
    </div>
  )
}

/**
 * One figure at rest, the full breakdown in an overlay on hover or focus.
 * The detail is a tooltip rather than an inline expansion so the message
 * never changes height under the pointer (#656).
 */
function UsageChip({ usage }: { usage: NonNullable<Message["usage"]> }) {
  const summary = usageSummary(usage)
  if (!summary) return null
  const detail = usageDetail(usage)
  return (
    <div className="msg-usage-row">
      <span className="msg-usage" role="note" tabIndex={0} aria-label={detail} data-tooltip={detail}>
        {summary}
      </span>
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

function renderMessageBlocks(message: Message, processOpen: boolean, processOnly: boolean, onReviewFile?: (path: string) => void) {
  if (message.role !== "assistant") return renderBlocks(message.blocks, false, onReviewFile)
  const pending = Boolean(message.pending)
  if (processOnly) {
    if (!hasProcessBlocks(message.blocks)) return null
    return <ProcessPanel blocks={message.blocks} pending={pending} defaultOpen={processOpen} onReviewFile={onReviewFile} />
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
      panel = <ProcessPanel blocks={process} pending={false} defaultOpen={false} onReviewFile={onReviewFile} />
    }
  } else if (hasProcessBlocks(message.blocks)) {
    // Ends on activity/reasoning — no distinct answer to surface yet, so the
    // whole message is the live process.
    panel = <ProcessPanel blocks={message.blocks} pending={pending} defaultOpen={processOpen} onReviewFile={onReviewFile} />
    answerBlocks = []
  }
  return (
    <>
      {panel}
      {renderBlocks(answerBlocks, false, onReviewFile, pending)}
    </>
  )
}

export type ProcessCluster = {
  id: string
  kind: "thought" | "command" | "read" | "search" | "edit" | "task" | "other"
  blocks: Block[]
  title: string
}

export function clusterProcessBlocks(blocks: Block[]): ProcessCluster[] {
  const clusters: { kind: ProcessCluster["kind"]; blocks: Block[] }[] = []
  for (const b of blocks) {
    if (b.type === "tool" && isSystemReminderTool(b.update.tool)) {
      continue
    }
    let kind: ProcessCluster["kind"] = "other"
    if (b.type === "reasoning") {
      kind = "thought"
    } else if (b.type === "tool") {
      const tool = b.update.tool
      if (tool === "bash" || tool === "shell" || tool === "sh" || tool === "terminal" || tool === "exec") {
        kind = "command"
      } else if (tool === "read") {
        kind = "read"
      } else if (tool === "grep" || tool === "glob") {
        kind = "search"
      } else if (tool === "edit" || tool === "write" || tool === "apply_patch") {
        kind = "edit"
      } else if (tool === "task") {
        kind = "task"
      } else {
        kind = "other"
      }
    } else if (b.type === "patch") {
      kind = "edit"
    } else if (b.type === "text") {
      kind = "thought"
    }

    const prev = clusters[clusters.length - 1]
    if (prev && prev.kind === kind) {
      prev.blocks.push(b)
    } else {
      clusters.push({ kind, blocks: [b] })
    }
  }

  return clusters.map((c, i) => {
    let title = ""
    if (c.kind === "thought") {
      title = "Thought"
    } else if (c.kind === "command") {
      const count = c.blocks.filter((b) => b.type === "tool").length
      title = `Ran ${count} ${count === 1 ? "command" : "commands"}`
    } else if (c.kind === "read") {
      const count = c.blocks.filter((b) => b.type === "tool").length
      title = `Explored ${count} ${count === 1 ? "file" : "files"}`
    } else if (c.kind === "search") {
      const count = c.blocks.filter((b) => b.type === "tool").length
      title = `${count} ${count === 1 ? "search" : "searches"}`
    } else if (c.kind === "edit") {
      const count = c.blocks.length
      title = `Edited ${count} ${count === 1 ? "file" : "files"}`
    } else if (c.kind === "task") {
      const count = c.blocks.filter((b) => b.type === "tool").length
      title = `Explored ${count} ${count === 1 ? "task" : "tasks"}`
    } else {
      title = processSummary(c.blocks) ?? processTitle(c.blocks)
    }
    return {
      id: `cluster-${i}`,
      kind: c.kind,
      blocks: c.blocks,
      title,
    }
  })
}

function ClusterPanel({
  cluster,
  pending,
  defaultOpen,
  onReviewFile,
}: {
  cluster: ProcessCluster
  pending: boolean
  defaultOpen?: boolean
  onReviewFile?: (path: string) => void
}) {
  const [userChoice, setUserChoice] = useState<boolean | undefined>(undefined)
  const autoOpen = pending ? true : Boolean(defaultOpen)
  const open = userChoice !== undefined ? userChoice : autoOpen
  const [everOpened, setEverOpened] = useState(open)

  useEffect(() => {
    if (open) setEverOpened(true)
  }, [open])

  const toggle = () => {
    const next = !open
    setUserChoice(next)
    if (next) setEverOpened(true)
  }

  return (
    <div className={`process sub-process ${open ? "is-open" : ""}`}>
      <button className="process-head" onClick={toggle} aria-expanded={open}>
        <span className="process-title">{cluster.title}</span>
        <span className={`process-caret ${open ? "is-open" : ""}`}>›</span>
      </button>
      <div className="process-body-clip">
        <div className="process-body">
          {everOpened ? renderBlocks(cluster.blocks, true, onReviewFile, pending) : null}
        </div>
      </div>
    </div>
  )
}

function TurnWorkPanel({
  blocks,
  assistants,
  pending,
  defaultOpen,
  onReviewFile,
}: {
  blocks: Block[]
  assistants: Message[]
  pending: boolean
  defaultOpen?: boolean
  onReviewFile?: (path: string) => void
}) {
  const [userChoice, setUserChoice] = useState<boolean | undefined>(undefined)
  const autoOpen = pending ? true : Boolean(defaultOpen)
  const open = userChoice !== undefined ? userChoice : autoOpen
  const [everOpened, setEverOpened] = useState(open)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pending])

  useEffect(() => {
    if (open) setEverOpened(true)
  }, [open])

  const toggle = () => {
    const next = !open
    setUserChoice(next)
    if (next) setEverOpened(true)
  }

  const clusters = useMemo(() => clusterProcessBlocks(blocks), [blocks])

  const hasTools = blocks.some((b) => b.type === "tool" || b.type === "patch")
  const startTime = assistants[0]?.time?.created
  const completedTime = assistants[assistants.length - 1]?.time?.completed

  let title: string
  if (pending) {
    const elapsed = startTime ? Math.max(0, now - startTime) : 0
    const elapsedStr = elapsed >= 2000 ? ` · ${formatElapsed(elapsed)}` : ""
    title = hasTools ? `Working${elapsedStr}` : `Thinking${elapsedStr}`
  } else {
    const duration = startTime && completedTime ? Math.max(0, completedTime - startTime) : 0
    if (duration > 0) {
      const durStr = formatElapsed(duration)
      title = hasTools ? `Worked for ${durStr}` : `Thought for ${durStr}`
    } else {
      title = hasTools ? (processSummary(blocks) ?? "Worked") : "Thought"
    }
  }

  const singleCluster = clusters.length === 1 ? clusters[0] : null

  return (
    <div className={`process turn-work ${open ? "is-open" : ""}`}>
      <button className="process-head turn-work-head" onClick={toggle} aria-expanded={open}>
        <span className="process-title">{title}</span>
        <span className={`process-caret ${open ? "is-open" : ""}`}>›</span>
      </button>
      <div className="process-body-clip">
        <div className="process-body turn-work-body">
          {everOpened ? (
            singleCluster ? (
              renderBlocks(singleCluster.blocks, true, onReviewFile, pending)
            ) : (
              clusters.map((cluster, i) => (
                <ClusterPanel
                  key={cluster.id}
                  cluster={cluster}
                  pending={pending && i === clusters.length - 1}
                  defaultOpen={pending && i === clusters.length - 1}
                  onReviewFile={onReviewFile}
                />
              ))
            )
          ) : null}
        </div>
      </div>
    </div>
  )
}

export type TurnAssistantsProps = {
  turn: { user?: Message; assistants: Message[]; key: string }
  busy?: boolean
  activeProcessID?: string
  onReviewFile?: (path: string) => void
  onRetry?: (assistantID: string) => void
  agentActivityMessageID?: string
  agentActivity?: AgentsStatusInfo
  agentActivityEntering?: string | null | boolean
  requestAgentActivity?: (taskID: string) => Promise<AgentActivityResult>
  retry?: SessionRetryInfo
  onOpenLink?: (url: string) => void
}

export function TurnAssistants({
  turn,
  busy,
  activeProcessID,
  onReviewFile,
  onRetry,
  agentActivityMessageID,
  agentActivity,
  agentActivityEntering,
  requestAgentActivity,
  retry,
  onOpenLink,
}: TurnAssistantsProps) {
  const assistants = turn.assistants
  if (!assistants.length) {
    if (busy) {
      return (
        <div className="msg role-assistant">
          <ThinkingLine quiet={false} />
        </div>
      )
    }
    return null
  }

  const first = assistants[0]
  if (first.summary && !first.error && !first.stopped) {
    return <CompactionMarker message={first} onReviewFile={onReviewFile} />
  }

  const last = assistants[assistants.length - 1]
  const lastAnswerStart = answerStartIndex(last.blocks)
  const lastProcessBlocks = last.blocks.slice(0, lastAnswerStart)

  const allProcessBlocks: Block[] = []
  for (let i = 0; i < assistants.length - 1; i++) {
    for (const b of assistants[i].blocks) {
      if (hasProcessBlocks([b])) allProcessBlocks.push(b)
    }
  }
  for (const b of lastProcessBlocks) {
    if (hasProcessBlocks([b])) allProcessBlocks.push(b)
  }

  const hasWork = allProcessBlocks.length > 0
  const turnPending = Boolean(busy || assistants.some((m) => m.pending))
  const isProcessOpen = assistants.some((m) => m.id === activeProcessID)

  return (
    <>
      {hasWork && (
        <TurnWorkPanel
          blocks={allProcessBlocks}
          assistants={assistants}
          pending={turnPending}
          defaultOpen={isProcessOpen}
          onReviewFile={onReviewFile}
        />
      )}
      {assistants.map((m, i) => {
        const isLast = i === assistants.length - 1
        const start = answerStartIndex(m.blocks)
        const answerBlocks = hasWork ? (isLast ? m.blocks.slice(start) : []) : (isLast ? m.blocks.slice(start) : m.blocks)
        const answerHasText = answerBlocks.some((b) => b.type === "text" && b.text.trim().length > 0)

        const currentActivity = m.id === agentActivityMessageID ? agentActivity : undefined
        const isEntering =
          agentActivityEntering === true ||
          (typeof agentActivityEntering === "string" && m.id === agentActivityEntering)

        const stopped = m.stopped || /^aborted$/i.test((m.error ?? "").trim())
        const isRetry = m.id === activeProcessID ? retry : undefined

        if (!hasWork) {
          return (
            <MessageView
              key={m.id}
              message={m}
              processOpen={m.id === activeProcessID}
              processOnly={m.pending || i < assistants.length - 1}
              busy={busy}
              onReviewFile={onReviewFile}
              onRetry={onRetry}
              agentActivity={currentActivity}
              agentActivityEntering={isEntering}
              requestAgentActivity={requestAgentActivity}
              retry={isRetry}
              onOpenLink={onOpenLink}
            />
          )
        }

        const showContent =
          answerHasText ||
          Boolean(m.error) ||
          Boolean(stopped) ||
          Boolean(currentActivity) ||
          Boolean(isRetry && m.pending) ||
          (!busy && !m.pending && Boolean(m.usage) && isLast)

        return (
          <div className="msg role-assistant" key={m.id}>
            {m.ref?.label && <div className="msg-ref">{m.ref.label}</div>}
            {showContent && renderBlocks(answerBlocks, false, onReviewFile, m.pending)}
            <AgentActivity status={currentActivity} entering={isEntering} requestActivity={requestAgentActivity} />
            {isRetry && m.pending && <RetryStatus retry={isRetry} onOpenLink={onOpenLink} />}
            {stopped ? (
              <div className="msg-stopped">
                <span>Stopped</span>
                {onRetry && !busy && (
                  <button
                    type="button"
                    className="msg-retry"
                    onClick={() => onRetry(m.id)}
                    title="Resend the same prompt"
                  >
                    Retry
                  </button>
                )}
              </div>
            ) : m.error ? (
              <div className="msg-error">{m.error}</div>
            ) : null}
            {!busy && !m.pending && isLast && m.usage && <UsageChip usage={m.usage} />}
          </div>
        )
      })}
    </>
  )
}

function ProcessPanel({
  blocks,
  pending,
  defaultOpen,
  onReviewFile,
}: {
  blocks: Block[]
  pending: boolean
  defaultOpen?: boolean
  onReviewFile?: (path: string) => void
}) {
  const [userChoice, setUserChoice] = useState<boolean | undefined>(undefined)
  const autoOpen = pending ? true : Boolean(defaultOpen)
  const open = userChoice !== undefined ? userChoice : autoOpen
  // Lazy mount: nothing renders inside a never-opened body — a long
  // transcript's collapsed tool traces and process text would otherwise all
  // render invisibly. Once opened it stays mounted so the 0fr fold
  // animation has content during collapse.
  const [everOpened, setEverOpened] = useState(open)

  useEffect(() => {
    if (open) setEverOpened(true)
  }, [open])

  const toggle = () => {
    const next = !open
    setUserChoice(next)
    if (next) setEverOpened(true)
  }

  const title = pending ? processTitle(blocks) : processSummary(blocks) ?? processTitle(blocks)

  return (
    <div className={`process ${open ? "is-open" : ""}`}>
      <button className="process-head" onClick={toggle} aria-expanded={open}>
        <span className="process-title">{title}</span>
        <span className={`process-caret ${open ? "is-open" : ""}`}>›</span>
      </button>
      {/* The clip wrapper stays mounted; the grid clips it to 0fr when
          collapsed so expand/collapse animates height instead of snapping. */}
      <div className="process-body-clip">
        <div className="process-body">{everOpened ? renderBlocks(blocks, true, onReviewFile, pending) : null}</div>
      </div>
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
/**
 * The pre-token placeholder. Quiet beside the Agents pill, whose dot is
 * already breathing for this turn; on its own it breathes on the shared
 * clock (#621).
 */
function ThinkingLine({ quiet }: { quiet: boolean }) {
  const phase = useLivePhase(!quiet)
  return (
    <div className={`thinking-dots${quiet ? "" : " live-breathe"}`} style={phase} role="status" aria-label="Thinking">
      thinking
    </div>
  )
}

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

function renderBlocks(blocks: Block[], processMode = false, onReviewFile?: (path: string) => void, streaming = false) {
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
        if (cleaned.trim()) nodes.push(<ProcessText key={i} text={cleaned} streaming={streaming} />)
      } else {
        const segments = splitWithReminders(b.text)
        segments.forEach((seg, j) => {
          const key = `${i}-${j}`
          if (seg.type === "reminder") {
            nodes.push(<SystemReminderCallout key={key} text={seg.content} />)
          } else {
            nodes.push(<Markdown key={key} text={seg.content} streaming={streaming} />)
          }
        })
      }
    }
    if (b.type === "reasoning") {
      const cleaned = stripInternalMarkers(b.text)
      if (!cleaned.trim()) return
      nodes.push(<ProcessText key={i} text={cleaned} streaming={streaming} />)
    }
  })
  flushTrace()
  return nodes
}

function ProcessText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  if (!text.trim()) return null
  const title = textTitle(text)
  if (!title) return <div className="process-text"><Markdown text={text} streaming={streaming} /></div>
  const body = stripDuplicateTitle(text, title)
  return (
    <div className="process-text">
      <div className="process-text-title">{title}</div>
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
