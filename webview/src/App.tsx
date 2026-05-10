import { useEffect, useRef, useState } from "react"
import { useChatState } from "./hooks/useChatState"
import type { Message } from "./hooks/useChatState"
import { MessageView } from "./components/MessageView"
import { PromptBox } from "./components/PromptBox"
import { StatusBar } from "./components/StatusBar"
import { PermissionDialog } from "./components/PermissionDialog"
import { ReviewPanel } from "./components/ReviewPanel"

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
    replyPermission,
    openReviewChange,
    editMessage,
    reviewAllInChange,
  } = useChatState()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [reviewRequest, setReviewRequest] = useState<{ path: string; key: number }>()
  const openReviewFile = (path: string) => {
    setReviewRequest((current) => ({ path, key: (current?.key ?? 0) + 1 }))
  }

  const busy = state.busy || state.messages.some((m) => m.pending)
  const activeProcessID = state.messages.findLast((m) => m.role === "assistant" && m.pending)?.id

  useEffect(() => {
    if (!scrollRef.current || !stickToBottom.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [state.messages])

  // When the user opens a different conversation from the History menu, jump
  // to the bottom (most recent messages) and re-enable sticky-bottom mode so
  // the previous conversation's scroll position doesn't leave the new one
  // anchored near the top.
  useEffect(() => {
    if (!scrollRef.current || !state.conversationID) return
    requestAnimationFrame(() => {
      if (!scrollRef.current) return
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      stickToBottom.current = true
    })
  }, [state.conversationID])

  return (
    <div className="app">
      <StatusBar
        connected={state.connected}
        error={state.error}
        selection={state.selection}
        conversations={state.conversations}
        activeConversationID={state.conversationID}
        onSelectAgent={selectAgent}
        onSelectModel={selectModel}
        onCreateConversation={newSession}
        onOpenConversation={openConversation}
        onRenameConversation={renameConversation}
        onDeleteConversation={deleteConversation}
      />
      <div
        className="messages"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {state.messages.length === 0 && (
          <div className="welcome">
            <div className="welcome-title">OpenCUI</div>
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
        {state.messages.map((m, i) => (
          <MessageView
            key={m.id}
            message={m}
            processOpen={m.id === activeProcessID}
            processOnly={m.role === "assistant" && (m.pending || hasLaterAssistantInTurn(state.messages, i))}
            busy={busy}
            onReviewFile={openReviewFile}
            onEditMessage={editMessage}
          />
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
      <ReviewPanel
        messages={state.messages}
        selectedPath={reviewRequest?.path}
        selectedKey={reviewRequest?.key}
        reviewedHunks={state.reviewHunks}
        onSelectPath={openReviewFile}
        onOpenReviewChange={openReviewChange}
        onReviewAllInChange={reviewAllInChange}
      />
      <PromptBox
        busy={busy}
        contextLabel={state.context?.label}
        onSend={send}
        onAbort={abort}
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

function hasLaterAssistantInTurn(messages: Message[], index: number) {
  const message = messages[index]
  if (message?.role !== "assistant") return false
  for (const next of messages.slice(index + 1)) {
    if (next.role === "user") return false
    if (next.role === "assistant") return true
  }
  return false
}
