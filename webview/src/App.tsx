import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { useChatState } from "./hooks/useChatState"
import type { Message } from "./hooks/useChatState"
import { useQueueFlush } from "./hooks/useQueueFlush"
import { useEscapeToStop } from "./hooks/useEscapeToStop"
import type { Attachment } from "./protocol"
import { MessageView } from "./components/MessageView"
import { PromptBox } from "./components/PromptBox"
import { QueuedMessages } from "./components/QueuedMessages"
import { StatusBar, type HeaderPopoverID } from "./components/StatusBar"
import { PermissionDialog } from "./components/PermissionDialog"
import { QuestionDialog } from "./components/QuestionDialog"
import { ReviewPanel } from "./components/ReviewPanel"
import { IndexStatus } from "./components/IndexStatus"
import { promptHistory } from "./prompt-history"

export default function App() {
  const {
    state,
    send,
    queueMessage,
    unqueueMessage,
    runCommand,
    abort,
    newSession,
    openConversation,
    importSession,
    refreshSessions,
    renameConversation,
    deleteConversation,
    setAgent,
    setModel,
    setProviderCollapsed,
    refreshModels,
    replyPermission,
    replyQuestion,
    rejectQuestion,
    openReviewChange,
    editMessage,
    reviewAllInChange,
    searchFiles,
    listDir,
    attachFile,
    startIndex,
    stopIndex,
    openLink,
  } = useChatState()
  const scrollRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  // Tracks whether the next onScroll fired from our own scrollTop= write
  // (so the synthetic event doesn't masquerade as a user gesture and
  // re-engage stick mode on every text delta).
  const programmaticScroll = useRef(false)
  const lastScrollTop = useRef(0)
  const pendingScrollRestore = useRef<{ top: number; stick: boolean } | null>(null)
  const [activeHeaderPopover, setActiveHeaderPopover] = useState<HeaderPopoverID | null>(null)
  const [editingMessageID, setEditingMessageID] = useState<string | null>(null)
  const [bottomDockHeight, setBottomDockHeight] = useState(0)
  const [messagesHeight, setMessagesHeight] = useState(0)
  // Distance-from-bottom threshold for *re-engaging* stick mode once the
  // user has manually disengaged it. Smaller than the old 80 px because we
  // now use scroll direction, not just position.
  const STICK_REENGAGE_PX = 8

  const setProgrammaticScrollTop = (top: number) => {
    if (!scrollRef.current) return
    const el = scrollRef.current
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight)
    const nextTop = Math.max(0, Math.min(top, maxTop))
    if (Math.abs(el.scrollTop - nextTop) > 0.5) {
      programmaticScroll.current = true
    }
    el.scrollTop = nextTop
    lastScrollTop.current = scrollRef.current.scrollTop
  }

  const scrollToBottom = () => {
    if (!scrollRef.current) return
    setProgrammaticScrollTop(scrollRef.current.scrollHeight - scrollRef.current.clientHeight)
  }

  const captureScrollForLocalLayoutChange = () => {
    if (!scrollRef.current) return
    pendingScrollRestore.current = {
      top: scrollRef.current.scrollTop,
      stick: stickToBottom.current,
    }
  }
  // Sending (or running a command) re-engages stick-to-bottom so the new turn
  // scrolls its question to the top via the last-turn spacer, even if the user
  // had scrolled up to read earlier messages.
  const sendAndPinTop = (...args: Parameters<typeof send>) => {
    stickToBottom.current = true
    send(...args)
  }
  const runCommandAndPinTop = (...args: Parameters<typeof runCommand>) => {
    stickToBottom.current = true
    runCommand(...args)
  }
  // Auto-send the oldest queued message when the session goes idle. Plain
  // `send` (not sendAndPinTop): the user may be reading scrollback when the
  // flush fires, and an auto-send must not yank their scroll position.
  useQueueFlush(state, (q) => {
    unqueueMessage(q.id)
    send(q.text, q.mentions, q.attachments, q.conversationMentions)
  })
  const [reviewRequest, setReviewRequest] = useState<{ path: string; key: number }>()
  const openReviewFile = (path: string) => {
    setReviewRequest((current) => ({ path, key: (current?.key ?? 0) + 1 }))
  }
  // Rapid clicks on different files in the Review panel make the editor pane
  // flip through them visibly. Debounce: only the final click in a burst
  // actually opens the editor.
  const openReviewChangeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const openReviewChangeDebounced = (change: Parameters<typeof openReviewChange>[0]) => {
    if (openReviewChangeTimer.current) clearTimeout(openReviewChangeTimer.current)
    openReviewChangeTimer.current = setTimeout(() => openReviewChange(change), 120)
  }
  useEffect(() => () => {
    if (openReviewChangeTimer.current) clearTimeout(openReviewChangeTimer.current)
  }, [])

  // Retry a stopped assistant response: walk back to the user message that
  // preceded it and re-run the edit flow with the same text / mentions /
  // attachments. The host's editMessage handler does session.revert + send,
  // so the partial assistant response is discarded and the LLM starts over.
  const handleRetry = (assistantID: string) => {
    const idx = state.messages.findIndex((m) => m.id === assistantID)
    if (idx <= 0) return
    for (let i = idx - 1; i >= 0; i--) {
      const m = state.messages[i]
      if (m.role !== "user") continue
      const textBlock = m.blocks.find((b) => b.type === "text")
      const text = textBlock && textBlock.type === "text" ? textBlock.text : ""
      if (!text) return
      const attachments: Attachment[] = []
      for (const [i, b] of m.blocks.entries()) {
        if (b.type === "attachment") {
          // Synthesize an id from the message + position — the original
          // upload-time id is lost after persistence, but handleSend only
          // uses (mime/filename/dataUrl/sourcePath) so any stable id works.
          attachments.push({
            id: `att_retry_${m.id}_${i}`,
            mime: b.mime,
            filename: b.filename,
            dataUrl: b.dataUrl,
            bytes: b.bytes,
            storageID: b.storageID,
          })
        }
      }
      editMessage(m.id, text, m.mentions, attachments, m.conversationMentions)
      return
    }
  }

  const { busy, activeProcessID, agentActivityMessageID } = useMemo(() => {
    const busy = state.busy || state.messages.some((m) => m.pending)
    const activeProcessID = state.messages.findLast((m) => m.role === "assistant" && m.pending)?.id
    const agentActivityMessageID = (state.agentsStatus?.total ?? 0) > 0
      ? activeProcessID ?? state.messages.findLast((m) => m.role === "assistant")?.id
      : undefined
    return { busy, activeProcessID, agentActivityMessageID }
  }, [state.messages, state.busy, state.agentsStatus?.total])
  // Rebuild the turn structure only when the message list actually changes,
  // not on every coalesced streaming frame.
  const turns = useMemo(() => groupTurns(state.messages), [state.messages])
  const promptHistoryEntries = useMemo(() => promptHistory(state.messages), [state.messages])

  // Active exactly when the Stop button is clickable.
  useEscapeToStop(busy && !state.aborting, abort)

  useEffect(() => {
    if (editingMessageID) setActiveHeaderPopover(null)
  }, [editingMessageID])

  useEffect(() => {
    if (!stickToBottom.current) return
    scrollToBottom()
  }, [state.messages])

  // The bottom dock (dialogs + review card + floating composer) is pinned over
  // the scroll area, so `.messages` reserves its height as bottom padding. The
  // dock is always mounted, so observe it once; the ResizeObserver picks up the
  // review card / dialogs appearing and disappearing.
  useLayoutEffect(() => {
    const el = dockRef.current
    if (!el) return
    const update = () => setBottomDockHeight(el.getBoundingClientRect().height)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Measure the scroll viewport so the last-turn spacer (which pins the newest
  // question to the top) can be sized to roughly one viewport minus the dock.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => setMessagesHeight(el.clientHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (!stickToBottom.current) return
    scrollToBottom()
  }, [bottomDockHeight, messagesHeight])

  // Entering/exiting in-place edit swaps a regular user bubble for an absolute
  // overlay. Chromium may treat the overlay's extra scrollable overflow as a
  // reason to adjust the scroll anchor, especially when the conversation is at
  // the bottom. Restore the pre-toggle scroll offset before paint so editing a
  // visible bubble does not make the whole transcript creep upward.
  useLayoutEffect(() => {
    const restore = pendingScrollRestore.current
    if (!restore) return
    pendingScrollRestore.current = null
    setProgrammaticScrollTop(restore.top)
    stickToBottom.current = restore.stick
  }, [editingMessageID])

  // When the user opens a different conversation from the History menu, jump
  // to the bottom (most recent messages) and re-enable sticky-bottom mode so
  // the previous conversation's scroll position doesn't leave the new one
  // anchored near the top.
  useEffect(() => {
    if (!scrollRef.current || !state.conversationID) return
    requestAnimationFrame(() => {
      stickToBottom.current = true
      scrollToBottom()
    })
  }, [state.conversationID])

  const appStyle = {
    "--bottom-dock-height": `${bottomDockHeight}px`,
    "--messages-height": `${messagesHeight}px`,
  } as CSSProperties

  return (
    <div className="app" style={appStyle}>
      <StatusBar
        connected={state.connected}
        error={state.error}
        continuationPending={state.continuationPending}
        selection={state.selection}
        modelCatalog={state.modelCatalog}
        conversations={state.conversations}
        externalSessions={state.externalSessions}
        activeConversationID={state.conversationID}
        activePopover={activeHeaderPopover}
        onActivePopoverChange={setActiveHeaderPopover}
        onSetAgent={setAgent}
        onSetModel={setModel}
        onSetProviderCollapsed={setProviderCollapsed}
        onRefreshModels={refreshModels}
        onCreateConversation={newSession}
        onOpenConversation={openConversation}
        onImportSession={importSession}
        onRefreshSessions={refreshSessions}
        onRenameConversation={renameConversation}
        onDeleteConversation={deleteConversation}
      />
      {state.indexStatus && state.indexStatus.state !== "disabled" && (
        <div className="index-status-wrap">
          <IndexStatus status={state.indexStatus} onStart={startIndex} onStop={stopIndex} />
        </div>
      )}
      {state.messages.length === 0 && (
        <PromptBox
          busy={busy}
          aborting={state.aborting}
          onSend={sendAndPinTop}
          onQueue={queueMessage}
          onAbort={abort}
          searchFiles={searchFiles}
          listDir={listDir}
          attachFile={attachFile}
          position="top"
          conversations={state.conversations}
          activeConversationID={state.conversationID}
          contextUsage={state.contextUsage}
          commands={state.commands}
          onRunCommand={runCommandAndPinTop}
          inject={state.injectedText}
          history={promptHistoryEntries}
          onOpenLink={openLink}
        />
      )}
      <div
        className="messages"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          // Consume the synthetic onScroll fired by our own scrollTop= write
          // so it never gets interpreted as a user gesture (which would
          // re-assert stick mode every text delta).
          if (programmaticScroll.current) {
            programmaticScroll.current = false
            lastScrollTop.current = el.scrollTop
            return
          }
          const prev = lastScrollTop.current
          const curr = el.scrollTop
          lastScrollTop.current = curr
          if (curr < prev) {
            // Any user-initiated upward movement breaks stick mode regardless
            // of distance to bottom — even one wheel notch.
            stickToBottom.current = false
            return
          }
          // Downward (or no) movement: re-engage stick only when the user
          // has actually reached the bottom on their own.
          if (el.scrollHeight - curr - el.clientHeight <= STICK_REENGAGE_PX) {
            stickToBottom.current = true
          }
        }}
      >
        {turns.map((turn) => (
          <div className="turn" key={turn.key}>
            {turn.user && (
              <MessageView
                key={turn.user.id}
                message={turn.user}
                processOpen={turn.user.id === activeProcessID}
                processOnly={false}
                busy={busy}
                onReviewFile={openReviewFile}
                onEditMessage={editMessage}
                onBeginEdit={(id) => {
                  captureScrollForLocalLayoutChange()
                  setActiveHeaderPopover(null)
                  setEditingMessageID(id)
                }}
                onEndEdit={(id) => {
                  captureScrollForLocalLayoutChange()
                  setEditingMessageID((current) => current === id ? null : current)
                }}
                searchFiles={searchFiles}
                listDir={listDir}
                attachFile={attachFile}
                conversations={state.conversations}
                activeConversationID={state.conversationID}
                onOpenLink={openLink}
              />
            )}
            {turn.assistants.map((m, i) => (
              <MessageView
                key={m.id}
                message={m}
                processOpen={m.id === activeProcessID}
                processOnly={m.pending || i < turn.assistants.length - 1}
                busy={busy}
                onReviewFile={openReviewFile}
                onEditMessage={editMessage}
                onRetry={handleRetry}
                agentActivity={m.id === agentActivityMessageID ? state.agentsStatus : undefined}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="bottom-dock" ref={dockRef}>
        {state.pendingPermission && (
          <PermissionDialog
            id={state.pendingPermission.id}
            title={state.pendingPermission.title}
            pattern={state.pendingPermission.pattern}
            onReply={replyPermission}
          />
        )}
        {state.pendingQuestion && (
          <QuestionDialog
            id={state.pendingQuestion.id}
            questions={state.pendingQuestion.questions}
            onReply={replyQuestion}
            onReject={rejectQuestion}
          />
        )}
        <ReviewPanel
          messages={state.messages}
          selectedPath={reviewRequest?.path}
          selectedKey={reviewRequest?.key}
          reviewedHunks={state.reviewHunks}
          onSelectPath={openReviewFile}
          onOpenReviewChange={openReviewChangeDebounced}
          onReviewAllInChange={reviewAllInChange}
        />
        <QueuedMessages queued={state.queued} onRemove={unqueueMessage} />
        {state.messages.length > 0 && (
          <div className="bottom-composer">
            <PromptBox
              busy={busy}
              aborting={state.aborting}
              onSend={sendAndPinTop}
              onQueue={queueMessage}
              onAbort={abort}
              searchFiles={searchFiles}
              listDir={listDir}
              attachFile={attachFile}
              conversations={state.conversations}
              activeConversationID={state.conversationID}
              contextUsage={state.contextUsage}
              commands={state.commands}
              onRunCommand={runCommandAndPinTop}
              inject={state.injectedText}
              history={promptHistoryEntries}
              onOpenLink={openLink}
            />
          </div>
        )}
      </div>
    </div>
  )
}

type Turn = { user?: Message; assistants: Message[]; key: string }

/**
 * Group a flat message list into per-turn buckets: each user message starts a
 * new turn and collects any assistant messages until the next user message.
 * Used to wrap each turn in its own DOM container so the sticky user-message
 * bubble has a bounded containing block — otherwise every user message tries
 * to stick at `top: 0` of the shared scroll container and they overlap.
 */
export function groupTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | undefined
  for (const m of messages) {
    if (m.role === "user") {
      if (current) turns.push(current)
      current = { user: m, assistants: [], key: m.id }
    } else {
      if (!current) current = { assistants: [], key: m.id }
      current.assistants.push(m)
    }
  }
  if (current) turns.push(current)
  return turns
}
