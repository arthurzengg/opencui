import { useEffect, useMemo, useReducer, useRef } from "react"
import { vscode } from "../vscode"
import { createDeltaCoalescer } from "../delta-coalescer"
import type {
  AgentsStatusInfo,
  Attachment,
  ChatBlock,
  ChatMessage,
  CommandInfo,
  ContextUsage,
  ConversationMention,
  ConversationSummary,
  ExternalSessionSummary,
  DirEntry,
  EditorContextRef,
  FileSearchHit,
  IndexStatusInfo,
  ModelCatalogInfo,
  Outbound,
  QuestionInfo,
  ReviewChange,
  ReviewChangeActor,
  ReviewHunkState,
  Selection,
  ToolUpdate,
} from "../protocol"

export type Block = ChatBlock
export type Message = ChatMessage

/**
 * A prompt the user submitted while a turn was still running. Held
 * webview-side (never crosses the wire) and flushed through the normal
 * `send` path when the session goes idle.
 */
export type QueuedMessage = {
  id: string
  text: string
  mentions?: string[]
  attachments?: Attachment[]
  conversationMentions?: ConversationMention[]
}

export type ChatState = {
  connected: boolean
  busy: boolean
  /**
   * True after the user pressed Stop and before opencode emitted sessionIdle.
   * While true: PromptBox shows a disabled "Stopping…" button, and the
   * reducer drops in-flight `textDelta` / `reasoningDelta` / `tool` / `patch`
   * events so opencode's last few queued frames don't keep extending the
   * already-stopped message.
   */
  aborting: boolean
  /**
   * True while the host is deferring a `sessionIdle` because a continuation
   * is imminent (background subagents, todo-continuation toast, etc.).
   * Busy stays true; the StatusBar surfaces a "Continuing…" indicator.
   */
  continuationPending: boolean
  error?: string
  selection: Selection
  /**
   * Host-pushed model list backing the in-panel picker. Arrives on connect
   * and after every preference change; workspace-scoped like `commands`, so
   * it survives conversation resets.
   */
  modelCatalog?: ModelCatalogInfo
  conversations: ConversationSummary[]
  externalSessions: ExternalSessionSummary[]
  conversationID?: string
  contextUsage?: ContextUsage
  /** Workspace opencode commands for the `/` picker (pushed by the host). */
  commands: CommandInfo[]
  context?: EditorContextRef
  messages: Message[]
  reviewHunks: Record<string, ReviewHunkState>
  pendingPermission?: { id: string; title: string; pattern?: string | string[] }
  pendingQuestion?: { id: string; questions: QuestionInfo[] }
  indexStatus?: IndexStatusInfo
  agentsStatus?: AgentsStatusInfo
  /**
   * One-shot signal to set the live composer's text (host `/undo` restoring the
   * undone prompt, `/redo` clearing it). The nonce makes identical text re-apply;
   * `PromptBox` consumes it via an effect.
   */
  injectedText?: { text: string; nonce: number }
  /** Prompts submitted while busy, waiting for the session to go idle. */
  queued: QueuedMessage[]
  /**
   * Counts `sessionIdle` events. The queue flush keys off this rather than
   * `busy`, because `busy` flickers false between assistant messages inside
   * one turn (`assistantDone` → next `assistantStart`) — flushing there would
   * inject the queued prompt mid-turn. `sessionIdle` is the only end-of-turn
   * signal, and the host already defers it during pending continuations.
   */
  idleNonce: number
}

export type Action =
  | Outbound
  | { type: "reset" }
  | { type: "clearPermission"; id: string }
  | { type: "clearQuestion"; id: string }
  | { type: "queueMessage"; message: QueuedMessage }
  | { type: "unqueueMessage"; id: string }

const initial: ChatState = {
  connected: false,
  busy: false,
  aborting: false,
  continuationPending: false,
  selection: {},
  conversations: [],
  externalSessions: [],
  commands: [],
  messages: [],
  reviewHunks: {},
  queued: [],
  idleNonce: 0,
}

function upsertMessage(messages: Message[], id: string, patch: Partial<Message>): Message[] {
  const idx = messages.findIndex((m) => m.id === id)
  if (idx < 0) {
    return messages
  }
  const copy = messages.slice()
  copy[idx] = { ...copy[idx], ...patch }
  return copy
}

function appendToLastBlock(
  messages: Message[],
  id: string,
  kind: "text" | "reasoning",
  delta: string,
): Message[] {
  const idx = messages.findIndex((m) => m.id === id)
  if (idx < 0) return messages
  const msg = messages[idx]
  const last = msg.blocks[msg.blocks.length - 1]
  let blocks: Block[]
  if (last && last.type === kind) {
    blocks = [...msg.blocks.slice(0, -1), { type: kind, text: last.text + delta }]
  } else {
    blocks = [...msg.blocks, { type: kind, text: delta }]
  }
  const copy = messages.slice()
  copy[idx] = { ...msg, blocks }
  return copy
}

function upsertTool(
  messages: Message[],
  id: string,
  update: ToolUpdate,
  actor?: ReviewChangeActor,
): Message[] {
  const idx = messages.findIndex((m) => m.id === id)
  if (idx < 0) return messages
  const msg = messages[idx]
  const existing = msg.blocks.findIndex(
    (b) => b.type === "tool" && b.update.callID === update.callID,
  )
  let blocks: Block[]
  if (existing >= 0) {
    blocks = msg.blocks.slice()
    const prev = blocks[existing]
    blocks[existing] = {
      type: "tool",
      update,
      actor: actor ?? (prev?.type === "tool" ? prev.actor : undefined),
    }
  } else {
    blocks = [...msg.blocks, { type: "tool", update, actor }]
  }
  const copy = messages.slice()
  copy[idx] = { ...msg, blocks }
  return copy
}

export { initial as initialChatState }

export function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case "reset":
      // idleNonce is monotonic for the webview's lifetime — resetting it to 0
      // would desync the flush hook's last-seen ref.
      return { ...initial, selection: state.selection, modelCatalog: state.modelCatalog, context: state.context, connected: state.connected, commands: state.commands, idleNonce: state.idleNonce }
    case "ready":
      return { ...state, connected: action.connected, selection: action.selection }
    case "connected":
      return { ...state, connected: action.connected, error: action.error }
    case "selection":
      return { ...state, selection: action.selection }
    case "modelCatalog":
      return { ...state, modelCatalog: action.catalog }
    case "contextUsage":
      return { ...state, contextUsage: action.usage }
    case "commands":
      return { ...state, commands: action.commands }
    case "setComposerText":
      return { ...state, injectedText: { text: action.text, nonce: (state.injectedText?.nonce ?? 0) + 1 } }
    case "conversations":
      return {
        ...state,
        conversations: action.conversations,
        conversationID: action.activeID,
        // Posts that predate a session-list fetch omit `external` — keep the
        // last known list rather than flashing the section empty.
        externalSessions: action.external ?? state.externalSessions,
      }
    case "restore":
      // Clear any pending composer inject — a conversation switch invalidates it.
      // `/undo` posts `restore` then `setComposerText`, so its restore re-sets it.
      return {
        ...state,
        busy: false,
        // A conversation switch invalidates any in-flight abort/continuation:
        // the old session's SSE subscription is torn down, so its `sessionIdle`
        // (the only thing that clears `aborting`) never arrives. Without this,
        // a stranded `aborting` leaves the new conversation's composer disabled
        // ("Stopping…") with no way to recover but a window reload.
        aborting: false,
        continuationPending: false,
        contextUsage: undefined,
        conversationID: action.conversationID,
        messages: action.messages,
        reviewHunks: action.reviewHunks ?? {},
        pendingPermission: undefined,
        // The host drops the old session's activeQuestions without posting
        // questionResolved on switch, so a question left open here would
        // render forever in the new conversation's dock.
        pendingQuestion: undefined,
        injectedText: undefined,
        // The queue is per-conversation: a switch (or /undo rewind) must not
        // fire the old conversation's follow-ups into the restored one.
        queued: [],
      }
    case "context":
      return { ...state, context: action.ref }
    case "userMessage": {
      const blocks: ChatBlock[] = []
      if (action.attachments) {
        for (const a of action.attachments) {
          blocks.push({
            type: "attachment",
            mime: a.mime,
            filename: a.filename,
            dataUrl: a.dataUrl,
            bytes: a.bytes,
            storageID: a.storageID,
          })
        }
      }
      blocks.push({ type: "text", text: action.text })
      return {
        ...state,
        busy: true,
        // Sending makes any pending /undo-restore inject stale.
        injectedText: undefined,
        messages: [
          ...state.messages,
          {
            id: action.id,
            role: "user",
            blocks,
            ref: action.ref,
            backendID: action.backendID,
            mentions: action.mentions,
            conversationMentions: action.conversationMentions,
          },
        ],
      }
    }
    case "userMessageBackendID":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id ? { ...m, backendID: action.backendID } : m,
        ),
      }
    case "userMessageContext":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id ? { ...m, context: action.context } : m,
        ),
      }
    case "assistantStart":
      // Mirror the textDelta/tool/patch gates: a late message.start racing in
      // after Stop must not append a fresh pending assistant bubble (it would
      // render with no Stopped badge once sessionIdle clears its pending flag).
      if (state.aborting) return state
      return {
        ...state,
        busy: true,
        messages: [...state.messages, { id: action.id, role: "assistant", blocks: [], pending: true }],
      }
    case "assistantSummary":
      // Presentation-only flag on an existing bubble; same ignore-while-
      // aborting gate as the other non-terminal stream events.
      if (state.aborting) return state
      return { ...state, messages: upsertMessage(state.messages, action.id, { summary: true }) }
    case "textDelta":
      // Drop deltas that race in after Stop — the message is already marked
      // `stopped: true` and opencode is still draining its in-flight response.
      if (state.aborting) return state
      return { ...state, messages: appendToLastBlock(state.messages, action.id, "text", action.delta) }
    case "reasoningDelta":
      if (state.aborting) return state
      return {
        ...state,
        messages: appendToLastBlock(state.messages, action.id, "reasoning", action.delta),
      }
    case "tool":
      // Drop in-flight churn while aborting, but apply TERMINAL closures —
      // a tool that finished before the abort propagated must not render
      // as "running" forever (mirrors the host-side gate).
      if (
        state.aborting &&
        action.update.status !== "completed" &&
        action.update.status !== "error"
      ) {
        return state
      }
      return { ...state, messages: upsertTool(state.messages, action.id, action.update, action.actor) }
    case "patch":
      // Patches describe disk mutations that already happened; hiding them
      // while aborting only desyncs the Review panel from reality.
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id
            ? { ...m, blocks: [...m.blocks, { type: "patch", files: action.files, diff: action.diff, actor: action.actor }] }
            : m,
        ),
      }
    case "reviewHunkState": {
      const reviewHunks = { ...state.reviewHunks }
      if (action.state) reviewHunks[action.key] = action.state
      else delete reviewHunks[action.key]
      return { ...state, reviewHunks }
    }
    case "assistantError": {
      // If the message was already marked stopped (user-initiated abort), the
      // error is just opencode telling us the LLM call was canceled — skip it
      // so we don't show both a Stopped badge and a red error block.
      const target = state.messages.find((m) => m.id === action.id)
      if (target?.stopped) return state
      return {
        ...state,
        busy: false,
        messages: upsertMessage(state.messages, action.id, { error: action.message, pending: false }),
      }
    }
    case "assistantDone":
      return {
        ...state,
        busy: false,
        messages: upsertMessage(state.messages, action.id, { pending: false, usage: action.usage }),
      }
    case "aborted": {
      // A Stop can race the turn's own completion: if sessionIdle was already
      // processed there is no turn left to stop, and no further sessionIdle
      // will arrive to clear `aborting` — entering the aborting state here
      // would wedge the composer at "Stopping…" forever (#579). The host
      // guards this too (turnActive); this is defense in depth.
      if (!state.busy && !state.messages.some((m) => m.role === "assistant" && m.pending)) {
        return state
      }
      // Stay busy (Send button must NOT re-enable yet) and enter aborting mode
      // until opencode sends sessionIdle. One abort = one Stopped badge: a
      // turn can contain multiple assistant messages (subtasks etc.), only the
      // last pending one carries the badge; the others just clear pending.
      let lastPendingIdx = -1
      state.messages.forEach((m, i) => {
        if (m.role === "assistant" && m.pending) lastPendingIdx = i
      })
      return {
        ...state,
        busy: true,
        aborting: true,
        pendingPermission: undefined,
        pendingQuestion: undefined,
        // Stop means stop: a queued follow-up auto-firing right after the
        // abort would restart the very work the user just killed. Messages
        // queued AFTER this (during the drain) are deliberate and survive.
        queued: [],
        messages: state.messages.map((m, i) => {
          if (m.role !== "assistant" || !m.pending) return m
          if (i === lastPendingIdx) return { ...m, pending: false, stopped: true }
          return { ...m, pending: false }
        }),
      }
    }
    case "sessionBusy":
      return { ...state, busy: true, continuationPending: false }
    case "sessionIdle":
      // Opencode finished draining its in-flight LLM call. Clear both flags so
      // the Send button comes back; ALSO clear `aborting` regardless of how we
      // got here (normal completion or abort tail).
      return {
        ...state,
        busy: false,
        aborting: false,
        continuationPending: false,
        idleNonce: state.idleNonce + 1,
        messages: state.messages.map((m) =>
          m.role === "assistant" && m.pending ? { ...m, pending: false } : m,
        ),
      }
    case "continuationPending":
      return { ...state, continuationPending: action.pending }
    case "permission":
      // Ignore-while-aborting, like the other non-terminal events: nothing
      // will answer a permission raised mid-Stop, so no `permissionResolved`
      // is coming for it and the dialog would sit there once the session dies.
      if (state.aborting) return state
      return {
        ...state,
        pendingPermission: { id: action.id, title: action.title, pattern: action.pattern },
      }
    case "permissionResolved":
    case "clearPermission":
      // Same id guard as questions: our reply clears the dialog locally, and
      // opencode's echoing `permission.replied` lands after a new permission
      // may already be showing — dismissing that one would drop a live prompt.
      return state.pendingPermission?.id === action.id
        ? { ...state, pendingPermission: undefined }
        : state
    case "question":
      if (state.aborting) return state
      return {
        ...state,
        pendingQuestion: { id: action.id, questions: action.questions },
      }
    case "questionResolved":
    case "clearQuestion":
      // Clear only if the resolved request matches the one we're showing —
      // a different one could have come in between (rare, but cheap to be safe).
      return state.pendingQuestion?.id === action.id
        ? { ...state, pendingQuestion: undefined }
        : state
    case "indexStatus":
      return { ...state, indexStatus: action.status }
    case "agentsStatus":
      return { ...state, agentsStatus: action.status }
    case "messageRemoved": {
      // opencode dropped a message from the session (revert, redo, internal
      // truncation). Drop it from local state; if it was pending, recompute
      // `busy` from the surviving messages so the prompt input re-enables.
      const next = state.messages.filter((m) => m.id !== action.id)
      if (next.length === state.messages.length) return state
      const anyPending = next.some((m) => m.pending)
      return { ...state, messages: next, busy: state.busy && anyPending }
    }
    case "queueMessage":
      return { ...state, queued: [...state.queued, action.message] }
    case "unqueueMessage":
      return { ...state, queued: state.queued.filter((q) => q.id !== action.id) }
    case "clear":
      return { ...initial, selection: state.selection, modelCatalog: state.modelCatalog, context: state.context, connected: state.connected, commands: state.commands, idleNonce: state.idleNonce }
    default:
      return state
  }
}

export function useChatState() {
  const [state, dispatch] = useReducer(reducer, initial)
  const fileSearchPending = useRef(new Map<number, (hits: FileSearchHit[]) => void>())
  const listDirPending = useRef(new Map<number, (entries: DirEntry[]) => void>())
  const attachPending = useRef(
    new Map<number, (result: { attachments: Attachment[]; error?: string }) => void>(),
  )
  const nextRequestID = useRef(1)
  const nextQueueID = useRef(1)

  useEffect(() => {
    // Streaming deltas are coalesced to one render per frame; request/response
    // messages below resolve their pending refs immediately (order-independent)
    // and bypass the queue.
    const coalescer = createDeltaCoalescer(dispatch)
    const off = vscode.onMessage((msg) => {
      if (msg.type === "fileSearchResult") {
        const resolver = fileSearchPending.current.get(msg.requestID)
        if (resolver) {
          fileSearchPending.current.delete(msg.requestID)
          resolver(msg.hits)
        }
        return
      }
      if (msg.type === "listDirResult") {
        const resolver = listDirPending.current.get(msg.requestID)
        if (resolver) {
          listDirPending.current.delete(msg.requestID)
          resolver(msg.entries)
        }
        return
      }
      if (msg.type === "attachmentResult") {
        const resolver = attachPending.current.get(msg.requestID)
        if (resolver) {
          attachPending.current.delete(msg.requestID)
          resolver({ attachments: msg.attachments, error: msg.error })
        }
        return
      }
      coalescer.enqueue(msg as Action)
    })
    vscode.post({ type: "mounted" })
    return off
  }, [])

  // Identity-stable API: everything captured below is render-stable (the
  // vscode shim is a module singleton, dispatch never changes identity, the
  // request/queue counters are refs). Without the memo, every state update —
  // including every streaming frame — handed consumers fresh callbacks, and
  // the ones sitting in effect deps (searchFiles in useMentionPicker, listDir
  // in useFileBrowser) re-fired a host round-trip per render while open.
  const api = useMemo(
    () => ({
    send(text: string, mentions?: string[], attachments?: Attachment[], conversationMentions?: ConversationMention[]) {
      vscode.post({ type: "send", text, mentions, attachments, conversationMentions })
    },
    queueMessage(text: string, mentions?: string[], attachments?: Attachment[], conversationMentions?: ConversationMention[]) {
      dispatch({
        type: "queueMessage",
        message: { id: `q_${Date.now()}_${nextQueueID.current++}`, text, mentions, attachments, conversationMentions },
      })
    },
    unqueueMessage(id: string) {
      dispatch({ type: "unqueueMessage", id })
    },
    runCommand(command: string, args: string) {
      vscode.post({ type: "runCommand", command, arguments: args })
    },
    editMessage(id: string, text: string, mentions?: string[], attachments?: Attachment[], conversationMentions?: ConversationMention[]) {
      vscode.post({ type: "editMessage", id, text, mentions, attachments, conversationMentions })
    },
    searchFiles(query: string): Promise<FileSearchHit[]> {
      const requestID = nextRequestID.current++
      return new Promise<FileSearchHit[]>((resolve) => {
        fileSearchPending.current.set(requestID, resolve)
        vscode.post({ type: "fileSearch", requestID, query })
        setTimeout(() => {
          if (fileSearchPending.current.delete(requestID)) resolve([])
        }, 5000)
      })
    },
    listDir(path: string): Promise<DirEntry[]> {
      const requestID = nextRequestID.current++
      return new Promise<DirEntry[]>((resolve) => {
        listDirPending.current.set(requestID, resolve)
        vscode.post({ type: "listDir", requestID, path })
        setTimeout(() => {
          if (listDirPending.current.delete(requestID)) resolve([])
        }, 5000)
      })
    },
    attachFile(): Promise<{ attachments: Attachment[]; error?: string }> {
      const requestID = nextRequestID.current++
      return new Promise((resolve) => {
        attachPending.current.set(requestID, resolve)
        vscode.post({ type: "attachFile", requestID })
        // File-dialog can sit open for a long time; give it 5 minutes.
        setTimeout(() => {
          if (attachPending.current.delete(requestID)) resolve({ attachments: [] })
        }, 5 * 60 * 1000)
      })
    },
    abort() {
      vscode.post({ type: "abort" })
    },
    newSession() {
      vscode.post({ type: "createConversation" })
    },
    openConversation(id: string) {
      vscode.post({ type: "openConversation", id })
    },
    importSession(sessionID: string) {
      vscode.post({ type: "importSession", sessionID })
    },
    refreshSessions() {
      vscode.post({ type: "refreshSessions" })
    },
    renameConversation(id: string, title: string) {
      vscode.post({ type: "renameConversation", id, title })
    },
    deleteConversation(id: string) {
      vscode.post({ type: "deleteConversation", id })
    },
    apply(code: string, language?: string) {
      vscode.post({ type: "apply", code, language })
    },
    openFile(path: string) {
      vscode.post({ type: "openFile", path })
    },
    openReviewChange(change: ReviewChange) {
      vscode.post({ type: "openReviewChange", change })
    },
    reviewAllInChange(source: string, path: string, action: ReviewHunkState) {
      vscode.post({ type: "reviewAllInChange", source, path, action })
    },
    setAgent(name?: string) {
      vscode.post({ type: "setAgent", name })
    },
    setModel(providerID?: string, modelID?: string, variant?: string) {
      vscode.post({ type: "setModel", providerID, modelID, variant })
    },
    refreshModels() {
      vscode.post({ type: "refreshModels" })
    },
    setProviderCollapsed(providerID: string, collapsed: boolean) {
      vscode.post({ type: "setProviderCollapsed", providerID, collapsed })
    },
    replyPermission(id: string, response: "once" | "always" | "reject") {
      vscode.post({ type: "permissionReply", id, response })
      dispatch({ type: "clearPermission", id })
    },
    replyQuestion(id: string, answers: string[][]) {
      vscode.post({ type: "questionReply", id, answers })
      dispatch({ type: "clearQuestion", id })
    },
    rejectQuestion(id: string) {
      vscode.post({ type: "questionReject", id })
      dispatch({ type: "clearQuestion", id })
    },
    startIndex() {
      vscode.post({ type: "startIndex" })
    },
    stopIndex() {
      vscode.post({ type: "stopIndex" })
    },
    openLink(url: string) {
      vscode.post({ type: "openExternal", url })
    },
    }),
    [],
  )
  return { state, ...api }
}
