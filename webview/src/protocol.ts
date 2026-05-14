/**
 * Message protocol between the VS Code extension (host) and the React webview.
 * Keep this file identical in both sides. The host imports via relative path.
 */

export type ToolStatus = "pending" | "running" | "completed" | "error"
export type ReviewHunkState = "accepted" | "rejected"
export type ReviewChange = {
  source: string
  path: string
  kind: "created" | "updated" | "deleted" | "moved"
  additions: number
  deletions: number
  patch: string
}

export type ToolUpdate = {
  callID: string
  tool: string
  status: ToolStatus
  title?: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
  output?: string
  error?: string
}

export type QuestionOption = { label: string; description: string }
export type QuestionInfo = {
  question: string
  header: string
  options: QuestionOption[]
  /** Allow selecting multiple options (default false). */
  multiple?: boolean
  /** Allow typing a custom free-text answer (default true). */
  custom?: boolean
}

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; update: ToolUpdate }
  | { type: "patch"; files: string[]; diff?: string }
  | { type: "attachment"; mime: string; filename: string; dataUrl: string; bytes: number }

export type ChatMessage = {
  id: string
  role: "user" | "assistant"
  blocks: ChatBlock[]
  ref?: EditorContextRef
  pending?: boolean
  error?: string
  usage?: UsageDelta
  backendID?: string
  /**
   * True when the user pressed Stop while this assistant message was streaming.
   * Rendered as a neutral grey "Stopped" badge instead of the red error block.
   * Distinct from `error`, which signals a real failure.
   */
  stopped?: boolean
  /**
   * @-mention paths the user originally selected when this message was sent.
   * Persisted on the message so the edit flow can preserve them — when the
   * user clicks an old user message to revise it, we know which `@path`
   * tokens in the text should still be treated as file context attachments.
   */
  mentions?: string[]
}

export type ConversationSummary = {
  id: string
  title: string
  updatedAt: number
}

export type Todo = {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority?: string
}

export type UsageDelta = {
  model?: string
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
  }
}

export type Selection = {
  agent?: string
  model?: string
}

export type EditorContextRef = {
  path?: string
  label?: string
}

export type FileSearchHit = { path: string; name: string }

export type Attachment = {
  /** Stable id used to dedup / remove an attachment in the prompt UI. */
  id: string
  mime: string
  filename: string
  /** `data:<mime>;base64,...` — used for `<img src>` previews in the bubble. */
  dataUrl: string
  /** Bytes of the underlying file (for size display + cap enforcement). */
  bytes: number
  /**
   * Absolute filesystem path on the host. When present we forward `file://<sourcePath>`
   * to opencode so the LLM can read the file directly (works for files outside
   * the workspace too). Stays optional because restored attachments from older
   * conversations may not have it.
   */
  sourcePath?: string
}

/** Messages sent from the extension host to the webview. */
export type Outbound =
  | { type: "ready"; connected: boolean; selection: Selection }
  | { type: "connected"; connected: boolean; error?: string }
  | { type: "selection"; selection: Selection }
  | { type: "conversations"; conversations: ConversationSummary[]; activeID?: string }
  | { type: "restore"; conversationID: string; messages: ChatMessage[]; reviewHunks?: Record<string, ReviewHunkState> }
  | { type: "context"; ref: EditorContextRef }
  | { type: "userMessage"; id: string; text: string; ref?: EditorContextRef; backendID?: string; attachments?: Attachment[]; mentions?: string[] }
  | { type: "userMessageBackendID"; id: string; backendID: string }
  | { type: "assistantStart"; id: string }
  | { type: "textDelta"; id: string; delta: string }
  | { type: "reasoningDelta"; id: string; delta: string }
  | { type: "tool"; id: string; update: ToolUpdate }
  | { type: "patch"; id: string; files: string[]; diff?: string }
  | { type: "reviewHunkState"; key: string; state?: ReviewHunkState }
  | { type: "assistantError"; id: string; message: string }
  | { type: "assistantDone"; id: string; usage?: UsageDelta }
  | { type: "aborted" }
  | { type: "sessionBusy" }
  | { type: "sessionIdle" }
  | { type: "permission"; id: string; title: string; pattern?: string | string[] }
  | { type: "question"; id: string; questions: QuestionInfo[] }
  | { type: "questionResolved"; id: string }
  | { type: "messageRemoved"; id: string }
  | { type: "fileSearchResult"; requestID: number; hits: FileSearchHit[] }
  | { type: "attachmentResult"; requestID: number; attachments: Attachment[]; error?: string }
  | { type: "clear" }

/** Messages sent from the webview to the extension host. */
export type Inbound =
  | { type: "mounted" }
  | { type: "send"; text: string; mentions?: string[]; attachments?: Attachment[] }
  | { type: "editMessage"; id: string; text: string; mentions?: string[]; attachments?: Attachment[] }
  | { type: "abort" }
  | { type: "newSession" }
  | { type: "createConversation" }
  | { type: "selectConversation" }
  | { type: "openConversation"; id: string }
  | { type: "renameConversation"; id: string; title: string }
  | { type: "deleteConversation"; id: string }
  | { type: "apply"; code: string; language?: string }
  | { type: "openFile"; path: string }
  | { type: "openReviewChange"; change: ReviewChange }
  | { type: "reviewHunk"; key: string; path: string; action: ReviewHunkState; oldText: string; newText: string }
  | { type: "reviewAllInChange"; source: string; path: string; action: ReviewHunkState }
  | { type: "selectAgent" }
  | { type: "selectModel" }
  | { type: "fileSearch"; requestID: number; query: string }
  | { type: "attachFile"; requestID: number }
  | { type: "permissionReply"; id: string; response: "once" | "always" | "reject" }
  | { type: "questionReply"; id: string; answers: string[][] }
  | { type: "questionReject"; id: string }
