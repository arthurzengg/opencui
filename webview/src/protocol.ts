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

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; update: ToolUpdate }
  | { type: "patch"; files: string[]; diff?: string }

export type ChatMessage = {
  id: string
  role: "user" | "assistant"
  blocks: ChatBlock[]
  ref?: EditorContextRef
  pending?: boolean
  error?: string
  usage?: UsageDelta
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

/** Messages sent from the extension host to the webview. */
export type Outbound =
  | { type: "ready"; connected: boolean; selection: Selection }
  | { type: "connected"; connected: boolean; error?: string }
  | { type: "selection"; selection: Selection }
  | { type: "conversations"; conversations: ConversationSummary[]; activeID?: string }
  | { type: "restore"; conversationID: string; messages: ChatMessage[]; todos: Todo[]; reviewHunks?: Record<string, ReviewHunkState> }
  | { type: "context"; ref: EditorContextRef }
  | { type: "userMessage"; id: string; text: string; ref?: EditorContextRef }
  | { type: "assistantStart"; id: string }
  | { type: "textDelta"; id: string; delta: string }
  | { type: "reasoningDelta"; id: string; delta: string }
  | { type: "tool"; id: string; update: ToolUpdate }
  | { type: "patch"; id: string; files: string[]; diff?: string }
  | { type: "todos"; todos: Todo[] }
  | { type: "reviewHunkState"; key: string; state?: ReviewHunkState }
  | { type: "assistantError"; id: string; message: string }
  | { type: "assistantDone"; id: string; usage?: UsageDelta }
  | { type: "aborted" }
  | { type: "sessionBusy" }
  | { type: "sessionIdle" }
  | { type: "permission"; id: string; title: string; pattern?: string | string[] }
  | { type: "clear" }

/** Messages sent from the webview to the extension host. */
export type Inbound =
  | { type: "mounted" }
  | { type: "send"; text: string }
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
  | { type: "selectAgent" }
  | { type: "selectModel" }
  | { type: "permissionReply"; id: string; response: "once" | "always" | "reject" }
