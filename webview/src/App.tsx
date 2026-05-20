import { useEffect, useRef, useState } from "react"
import { useChatState } from "./hooks/useChatState"
import type { Message } from "./hooks/useChatState"
import type { Attachment } from "./protocol"
import { MessageView } from "./components/MessageView"
import { PromptBox } from "./components/PromptBox"
import { StatusBar } from "./components/StatusBar"
import { PermissionDialog } from "./components/PermissionDialog"
import { QuestionDialog } from "./components/QuestionDialog"
import { ReviewPanel } from "./components/ReviewPanel"
import { IndexStatus } from "./components/IndexStatus"

export default function App() {
  const {
    state,
    send,
    abort,
    newSession,
    openConversation,
    renameConversation,
    deleteConversation,
    selectAgent,
    selectModel,
    selectVariant,
    replyPermission,
    replyQuestion,
    rejectQuestion,
    openReviewChange,
    editMessage,
    reviewAllInChange,
    searchFiles,
    attachFile,
    startIndex,
    stopIndex,
  } = useChatState()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  // Tracks whether the next onScroll fired from our own scrollTop= write
  // (so the synthetic event doesn't masquerade as a user gesture and
  // re-engage stick mode on every text delta).
  const programmaticScroll = useRef(false)
  const lastScrollTop = useRef(0)
  // Distance-from-bottom threshold for *re-engaging* stick mode once the
  // user has manually disengaged it. Smaller than the old 80 px because we
  // now use scroll direction, not just position.
  const STICK_REENGAGE_PX = 8

  const scrollToBottom = () => {
    if (!scrollRef.current) return
    programmaticScroll.current = true
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    lastScrollTop.current = scrollRef.current.scrollTop
  }
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
          })
        }
      }
      editMessage(m.id, text, m.mentions, attachments)
      return
    }
  }

  const busy = state.busy || state.messages.some((m) => m.pending)
  const activeProcessID = state.messages.findLast((m) => m.role === "assistant" && m.pending)?.id

  useEffect(() => {
    if (!stickToBottom.current) return
    scrollToBottom()
  }, [state.messages])

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

  return (
    <div className="app">
      <StatusBar
        connected={state.connected}
        error={state.error}
        continuationPending={state.continuationPending}
        selection={state.selection}
        conversations={state.conversations}
        activeConversationID={state.conversationID}
        agentsStatus={state.agentsStatus}
        onSelectAgent={selectAgent}
        onSelectModel={selectModel}
        onSelectVariant={selectVariant}
        onCreateConversation={newSession}
        onOpenConversation={openConversation}
        onRenameConversation={renameConversation}
        onDeleteConversation={deleteConversation}
      />
      {state.indexStatus && state.indexStatus.state !== "disabled" && (
        <div className="index-status-wrap">
          <IndexStatus status={state.indexStatus} onStart={startIndex} onStop={stopIndex} />
        </div>
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
        {state.messages.length === 0 && (
          <div className="welcome">
            <div className="welcome-title">OpenCode Panel</div>
            <div className="welcome-sub">Ask about the current file, refactor code, or run a task.</div>
            <div className="welcome-suggestions">
              {WELCOME_PROMPTS.map((prompt) => (
                <button key={prompt} className="welcome-suggestion" onClick={() => send(prompt)}>
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
        {groupTurns(state.messages).map((turn) => (
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
                searchFiles={searchFiles}
                attachFile={attachFile}
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
              />
            ))}
          </div>
        ))}
      </div>
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
      <PromptBox
        busy={busy}
        aborting={state.aborting}
        contextLabel={state.context?.label}
        onSend={send}
        onAbort={abort}
        searchFiles={searchFiles}
        attachFile={attachFile}
      />
    </div>
  )
}

const WELCOME_PROMPTS = [
  "Explain this file",
  "Find bugs in the current file",
  "Add tests for this file",
  "Refactor this for readability",
]

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
