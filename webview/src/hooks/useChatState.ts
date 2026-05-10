import { useEffect, useReducer, useRef } from "react"
import { vscode } from "../vscode"
import type {
  Attachment,
  ChatBlock,
  ChatMessage,
  ConversationSummary,
  EditorContextRef,
  FileSearchHit,
  Outbound,
  ReviewChange,
  ReviewHunkState,
  Selection,
  ToolUpdate,
  UsageDelta,
} from "../protocol"

export type Block = ChatBlock
export type Message = ChatMessage

export type ChatState = {
  connected: boolean
  busy: boolean
  error?: string
  selection: Selection
  conversations: ConversationSummary[]
  conversationID?: string
  context?: EditorContextRef
  messages: Message[]
  reviewHunks: Record<string, ReviewHunkState>
  pendingPermission?: { id: string; title: string; pattern?: string | string[] }
}

type Action = Outbound | { type: "reset" } | { type: "clearPermission" }

const initial: ChatState = {
  connected: false,
  busy: false,
  selection: {},
  conversations: [],
  messages: [],
  reviewHunks: {},
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

function upsertTool(messages: Message[], id: string, update: ToolUpdate): Message[] {
  const idx = messages.findIndex((m) => m.id === id)
  if (idx < 0) return messages
  const msg = messages[idx]
  const existing = msg.blocks.findIndex(
    (b) => b.type === "tool" && b.update.callID === update.callID,
  )
  let blocks: Block[]
  if (existing >= 0) {
    blocks = msg.blocks.slice()
    blocks[existing] = { type: "tool", update }
  } else {
    blocks = [...msg.blocks, { type: "tool", update }]
  }
  const copy = messages.slice()
  copy[idx] = { ...msg, blocks }
  return copy
}

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case "reset":
      return { ...initial, selection: state.selection, context: state.context, connected: state.connected }
    case "ready":
      return { ...state, connected: action.connected, selection: action.selection }
    case "connected":
      return { ...state, connected: action.connected, error: action.error }
    case "selection":
      return { ...state, selection: action.selection }
    case "conversations":
      return { ...state, conversations: action.conversations, conversationID: action.activeID }
    case "restore":
      return {
        ...state,
        busy: false,
        conversationID: action.conversationID,
        messages: action.messages,
        reviewHunks: action.reviewHunks ?? {},
        pendingPermission: undefined,
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
          })
        }
      }
      blocks.push({ type: "text", text: action.text })
      return {
        ...state,
        busy: true,
        messages: [
          ...state.messages,
          { id: action.id, role: "user", blocks, ref: action.ref, backendID: action.backendID },
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
    case "assistantStart":
      return {
        ...state,
        busy: true,
        messages: [...state.messages, { id: action.id, role: "assistant", blocks: [], pending: true }],
      }
    case "textDelta":
      return { ...state, messages: appendToLastBlock(state.messages, action.id, "text", action.delta) }
    case "reasoningDelta":
      return {
        ...state,
        messages: appendToLastBlock(state.messages, action.id, "reasoning", action.delta),
      }
    case "tool":
      return { ...state, messages: upsertTool(state.messages, action.id, action.update) }
    case "patch":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id ? { ...m, blocks: [...m.blocks, { type: "patch", files: action.files, diff: action.diff }] } : m,
        ),
      }
    case "reviewHunkState": {
      const reviewHunks = { ...state.reviewHunks }
      if (action.state) reviewHunks[action.key] = action.state
      else delete reviewHunks[action.key]
      return { ...state, reviewHunks }
    }
    case "assistantError":
      return {
        ...state,
        busy: false,
        messages: upsertMessage(state.messages, action.id, { error: action.message, pending: false }),
      }
    case "assistantDone":
      return {
        ...state,
        busy: false,
        messages: upsertMessage(state.messages, action.id, { pending: false, usage: action.usage }),
      }
    case "aborted":
      return {
        ...state,
        busy: false,
        pendingPermission: undefined,
        messages: state.messages.map((m) =>
          m.role === "assistant" && m.pending ? { ...m, pending: false, error: "Stopped" } : m,
        ),
      }
    case "sessionBusy":
      return { ...state, busy: true }
    case "sessionIdle":
      return {
        ...state,
        busy: false,
        messages: state.messages.map((m) =>
          m.role === "assistant" && m.pending ? { ...m, pending: false } : m,
        ),
      }
    case "permission":
      return {
        ...state,
        pendingPermission: { id: action.id, title: action.title, pattern: action.pattern },
      }
    case "clearPermission":
      return { ...state, pendingPermission: undefined }
    case "clear":
      return { ...initial, selection: state.selection, context: state.context, connected: state.connected }
    default:
      return state
  }
}

export function useChatState() {
  const [state, dispatch] = useReducer(reducer, initial)
  const fileSearchPending = useRef(new Map<number, (hits: FileSearchHit[]) => void>())
  const attachPending = useRef(
    new Map<number, (result: { attachments: Attachment[]; error?: string }) => void>(),
  )
  const nextRequestID = useRef(1)

  useEffect(() => {
    const off = vscode.onMessage((msg) => {
      if (msg.type === "fileSearchResult") {
        const resolver = fileSearchPending.current.get(msg.requestID)
        if (resolver) {
          fileSearchPending.current.delete(msg.requestID)
          resolver(msg.hits)
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
      dispatch(msg as Action)
    })
    vscode.post({ type: "mounted" })
    return off
  }, [])

  return {
    state,
    send(text: string, mentions?: string[], attachments?: Attachment[]) {
      vscode.post({ type: "send", text, mentions, attachments })
    },
    editMessage(id: string, text: string, mentions?: string[], attachments?: Attachment[]) {
      vscode.post({ type: "editMessage", id, text, mentions, attachments })
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
    selectConversation() {
      vscode.post({ type: "selectConversation" })
    },
    openConversation(id: string) {
      vscode.post({ type: "openConversation", id })
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
    reviewHunk(key: string, path: string, action: ReviewHunkState, oldText: string, newText: string) {
      vscode.post({ type: "reviewHunk", key, path, action, oldText, newText })
    },
    reviewAllInChange(source: string, path: string, action: ReviewHunkState) {
      vscode.post({ type: "reviewAllInChange", source, path, action })
    },
    selectAgent() {
      vscode.post({ type: "selectAgent" })
    },
    selectModel() {
      vscode.post({ type: "selectModel" })
    },
    replyPermission(id: string, response: "once" | "always" | "reject") {
      vscode.post({ type: "permissionReply", id, response })
      dispatch({ type: "clearPermission" })
    },
  }
}
