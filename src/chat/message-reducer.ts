import type {
  ChatBlock,
  ChatMessage,
  Outbound,
  ReviewChangeActor,
  ReviewHunkState,
  ToolUpdate as WireToolUpdate,
} from "../protocol"

export interface ReducerState {
  messages: ChatMessage[]
  reviewHunks: Record<string, ReviewHunkState>
}

/**
 * Result of reducing one Outbound message into the local chat state. `save` and
 * `syncDecorations` tell the caller which side effects to run (persist the
 * active conversation, re-sync review decorations) — the reducer itself stays
 * pure so each variant can be tested in isolation. A `null` return means the
 * message is not a local-state mutation and should be ignored here.
 */
export interface ReduceResult extends ReducerState {
  save: boolean
  syncDecorations: boolean
}

export function reduceLocal(state: ReducerState, msg: Outbound): ReduceResult | null {
  const { messages, reviewHunks } = state
  const keep = { messages, reviewHunks }
  switch (msg.type) {
    case "restore":
      return {
        messages: msg.messages.map((m) => ({ ...m, pending: false })),
        reviewHunks: msg.reviewHunks ?? {},
        save: false,
        syncDecorations: true,
      }
    case "clear":
      return { messages: [], reviewHunks: {}, save: true, syncDecorations: false }
    case "userMessage": {
      const blocks: ChatBlock[] = []
      if (msg.attachments) {
        for (const a of msg.attachments) {
          blocks.push({
            type: "attachment",
            mime: a.mime,
            filename: a.filename,
            dataUrl: a.dataUrl,
            bytes: a.bytes,
          })
        }
      }
      blocks.push({ type: "text", text: msg.text })
      return {
        ...keep,
        messages: [
          ...messages,
          {
            id: msg.id,
            role: "user",
            blocks,
            ref: msg.ref,
            backendID: msg.backendID,
            mentions: msg.mentions,
            conversationMentions: msg.conversationMentions,
          },
        ],
        save: true,
        syncDecorations: false,
      }
    }
    case "userMessageBackendID":
      return {
        ...keep,
        messages: messages.map((m) => (m.id === msg.id ? { ...m, backendID: msg.backendID } : m)),
        save: true,
        syncDecorations: false,
      }
    case "userMessageContext":
      return {
        ...keep,
        messages: messages.map((m) => (m.id === msg.id ? { ...m, context: msg.context } : m)),
        save: true,
        syncDecorations: false,
      }
    case "assistantStart":
      return {
        ...keep,
        messages: [...messages, { id: msg.id, role: "assistant", blocks: [], pending: true }],
        save: true,
        syncDecorations: false,
      }
    case "textDelta":
      return {
        ...keep,
        messages: appendText(messages, msg.id, "text", msg.delta),
        save: true,
        syncDecorations: false,
      }
    case "reasoningDelta":
      return {
        ...keep,
        messages: appendText(messages, msg.id, "reasoning", msg.delta),
        save: true,
        syncDecorations: false,
      }
    case "tool":
      return {
        ...keep,
        messages: upsertTool(messages, msg.id, msg.update, msg.actor),
        save: true,
        syncDecorations: true,
      }
    case "patch":
      return {
        ...keep,
        messages: messages.map((m) =>
          m.id === msg.id
            ? { ...m, blocks: [...m.blocks, { type: "patch", files: msg.files, diff: msg.diff, actor: msg.actor }] }
            : m,
        ),
        save: true,
        syncDecorations: true,
      }
    case "reviewHunkState": {
      const next = { ...reviewHunks }
      if (msg.state) next[msg.key] = msg.state
      else delete next[msg.key]
      return { messages, reviewHunks: next, save: true, syncDecorations: true }
    }
    case "assistantError":
      return {
        ...keep,
        messages: messages.map((m) => (m.id === msg.id ? { ...m, error: msg.message, pending: false } : m)),
        save: true,
        syncDecorations: false,
      }
    case "assistantDone":
      return {
        ...keep,
        messages: messages.map((m) => (m.id === msg.id ? { ...m, pending: false, usage: msg.usage } : m)),
        save: true,
        syncDecorations: false,
      }
    case "aborted": {
      // Only the LAST pending assistant in the turn carries the Stopped badge;
      // intermediate ones just clear pending. Otherwise multi-step turns
      // (subtasks, retries) show several Stopped badges per abort.
      let lastPendingIdx = -1
      messages.forEach((m, i) => {
        if (m.role === "assistant" && m.pending) lastPendingIdx = i
      })
      return {
        ...keep,
        messages: messages.map((m, i) => {
          if (m.role !== "assistant" || !m.pending) return m
          if (i === lastPendingIdx) return { ...m, pending: false, stopped: true }
          return { ...m, pending: false }
        }),
        save: true,
        syncDecorations: false,
      }
    }
    case "sessionIdle":
      return {
        ...keep,
        messages: messages.map((m) =>
          m.role === "assistant" && m.pending ? { ...m, pending: false } : m,
        ),
        save: true,
        syncDecorations: false,
      }
  }
  return null
}

function appendText(
  messages: ChatMessage[],
  id: string,
  kind: "text" | "reasoning",
  delta: string,
): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== id) return message
    const last = message.blocks[message.blocks.length - 1]
    if (last?.type === kind) {
      return {
        ...message,
        blocks: [...message.blocks.slice(0, -1), { type: kind, text: last.text + delta }],
      }
    }
    return { ...message, blocks: [...message.blocks, { type: kind, text: delta }] }
  })
}

function upsertTool(
  messages: ChatMessage[],
  id: string,
  update: WireToolUpdate,
  actor?: ReviewChangeActor,
): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== id) return message
    const existing = message.blocks.findIndex((b) => b.type === "tool" && b.update.callID === update.callID)
    if (existing >= 0) {
      const blocks = message.blocks.slice()
      const prev = blocks[existing]
      blocks[existing] = {
        type: "tool",
        update,
        actor: actor ?? (prev.type === "tool" ? prev.actor : undefined),
      }
      return { ...message, blocks }
    }
    return { ...message, blocks: [...message.blocks, { type: "tool", update, actor }] }
  })
}
