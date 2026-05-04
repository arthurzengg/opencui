import type { Backend } from "../server"
import { log } from "../output"

export type ToolUpdate = {
  callID: string
  tool: string
  status: "pending" | "running" | "completed" | "error"
  title?: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
  output?: string
  error?: string
}

export type PermissionRequest = {
  id: string
  title: string
  pattern?: string | string[]
  type?: string
}

export type MessageUsage = {
  model?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number }
}

export type StreamHandlers = {
  /** Fired when the SSE connection is open and subscribed. */
  onReady?: () => void
  /** Fired when a new assistant message appears for this session. */
  onAssistantStart?: (messageID: string) => void
  /** Fired once when an assistant message is marked finished or errored. */
  onAssistantEnd?: (messageID: string, payload: { usage?: MessageUsage; finish?: string; error?: string }) => void
  /** Text-field deltas for a specific assistant message. */
  onTextDelta: (messageID: string, delta: string) => void
  onReasoningDelta?: (messageID: string, delta: string) => void
  /** Tool state transitions, scoped to the owning assistant message. */
  onTool?: (messageID: string, update: ToolUpdate) => void
  onPatch?: (messageID: string, files: string[], diff?: string) => void
  onFileRead?: (messageID: string, filename: string) => void
  onPermissionNeeded?: (permission: PermissionRequest) => void
  onSessionError?: (message: string) => void
  onSessionIdle?: () => void
  onSessionBusy?: () => void
}

export type Subscription = {
  ready: Promise<void>
  abort: () => void
}

/**
 * Long-lived subscription to session events. Does NOT close on message finish —
 * stays open until abort() is called. This lets the UI capture follow-up
 * assistant turns that are auto-triggered by background-task reminders,
 * permission replies, or any other opencode-side continuation.
 */
export function subscribeSession(
  backend: Backend,
  sessionID: string,
  handlers: StreamHandlers,
): Subscription {
  const controller = new AbortController()

  const seenLen = new Map<string, number>()
  const seenAssistantMessages = new Set<string>()
  const assistantFinished = new Set<string>()
  const toolStatus = new Map<string, string>()
  const seenPatches = new Set<string>()

  let readyResolve: () => void = () => {}
  let readyReject: (e: unknown) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })

  void (async () => {
    try {
      const sse = await backend.client.global.event({ signal: controller.signal })
      log(`[sse] connected for session ${sessionID}`)
      handlers.onReady?.()
      readyResolve()
      for await (const evt of sse.stream as AsyncIterable<{ payload?: unknown }>) {
        const payload = eventPayload(evt.payload ?? evt)
        if (!payload?.type) continue
        route(payload.type, payload.properties)
      }
    } catch (e) {
      if (controller.signal.aborted) return
      log("event stream error", e)
      handlers.onSessionError?.((e as Error).message)
      readyReject(e)
    }
  })()

  function route(type: string, props: any) {
    log(`[sse] ${type}`)
    switch (type) {
      case "message.updated":
        return onMessageUpdated(props?.info)
      case "message.part.updated":
        return onPartUpdated(props?.part)
      case "message.part.delta":
        return onPartDelta(props)
      case "permission.asked":
      case "permission.updated":
        return onPermissionUpdated(props)
      case "session.error":
        return onSessionError(props?.error)
      case "session.idle":
        if (props?.sessionID === sessionID) handlers.onSessionIdle?.()
        return
      case "session.status":
        if (props?.sessionID === sessionID && props?.status?.type === "idle") handlers.onSessionIdle?.()
        if (props?.sessionID === sessionID && props?.status?.type && props.status.type !== "idle") handlers.onSessionBusy?.()
        return
    }
  }

  function onMessageUpdated(info: any) {
    if (!info || info.sessionID !== sessionID) return
    if (info.role !== "assistant") return
    const mid = info.id as string
    if (!seenAssistantMessages.has(mid)) {
      seenAssistantMessages.add(mid)
      handlers.onAssistantStart?.(mid)
    }
    if (info.error && !assistantFinished.has(mid)) {
      assistantFinished.add(mid)
      const err = info.error as { name?: string; data?: { message?: string } }
      handlers.onAssistantEnd?.(mid, {
        error: err.data?.message ?? err.name ?? "unknown error",
        finish: info.finish,
      })
      return
    }
    if (info.finish && !assistantFinished.has(mid)) {
      // A finish=tool-calls indicates a mid-turn pause. The same message will
      // receive more parts when the agent resumes, so DO NOT emit assistantEnd
      // for that. Only terminal finish reasons end the message.
      if (isTerminalFinish(info.finish)) {
        assistantFinished.add(mid)
        handlers.onAssistantEnd?.(mid, {
          finish: info.finish,
          usage: extractUsage(info),
        })
      }
    }
  }

  function onPartUpdated(part: any) {
    if (!part || part.sessionID !== sessionID) return
    const messageID = part.messageID as string | undefined
    if (!messageID) return
    if (!seenAssistantMessages.has(messageID)) {
      seenAssistantMessages.add(messageID)
      handlers.onAssistantStart?.(messageID)
    }
    const partID = part.id as string | undefined
    if (part.type === "text" && typeof part.text === "string" && partID) {
      const seen = seenLen.get(partID) ?? 0
      if (part.text.length > seen) {
        handlers.onTextDelta(messageID, part.text.slice(seen))
        seenLen.set(partID, part.text.length)
      }
      return
    }
    if (part.type === "reasoning" && typeof part.text === "string" && partID) {
      const seen = seenLen.get(partID) ?? 0
      if (part.text.length > seen) {
        handlers.onReasoningDelta?.(messageID, part.text.slice(seen))
        seenLen.set(partID, part.text.length)
      }
      return
    }
    if (part.type === "tool" && part.callID && part.tool && part.state) {
      const key = part.callID as string
      const curr = part.state.status as ToolUpdate["status"]
      toolStatus.set(key, curr)
      if (curr === "running" || curr === "completed" || curr === "error") {
        handlers.onTool?.(messageID, {
          callID: key,
          tool: part.tool,
          status: curr,
          title: part.state.title,
          input: part.state.input,
          metadata: part.state.metadata,
          output: part.state.output,
          error: part.state.error,
        })
      }
      return
    }
    if (part.type === "patch" && part.hash && Array.isArray(part.files)) {
      if (seenPatches.has(part.hash)) return
      seenPatches.add(part.hash)
      handlers.onPatch?.(messageID, part.files, typeof part.diff === "string" ? part.diff : undefined)
      return
    }
    if (part.type === "file" && typeof part.filename === "string") {
      handlers.onFileRead?.(messageID, part.filename)
      return
    }
  }

  function onPartDelta(p: any) {
    if (!p || p.sessionID !== sessionID) return
    const messageID = p.messageID as string | undefined
    const partID = p.partID as string | undefined
    if (!messageID || !partID) return
    if (!seenAssistantMessages.has(messageID)) {
      seenAssistantMessages.add(messageID)
      handlers.onAssistantStart?.(messageID)
    }
    if (p.field === "text") {
      handlers.onTextDelta(messageID, p.delta)
      seenLen.set(partID, (seenLen.get(partID) ?? 0) + p.delta.length)
    } else if (p.field === "reasoning") {
      handlers.onReasoningDelta?.(messageID, p.delta)
      seenLen.set(partID, (seenLen.get(partID) ?? 0) + p.delta.length)
    }
  }

  function onPermissionUpdated(p: any) {
    if (!p || p.sessionID !== sessionID) return
    handlers.onPermissionNeeded?.({
      id: p.id,
      title: p.title ?? `Permission needed: ${p.permission ?? p.type ?? "unknown"}`,
      pattern: p.pattern ?? p.patterns,
      type: p.permission ?? p.type,
    })
  }

  function onSessionError(err: any) {
    const msg = err?.data?.message ?? err?.name ?? "session error"
    handlers.onSessionError?.(msg)
  }

  return { ready, abort: () => controller.abort() }
}

function eventPayload(payload: unknown): { type?: string; properties?: any } | undefined {
  const direct = payload as { type?: string; properties?: any } | undefined
  if (direct?.type) return direct
  return (payload as { payload?: { type?: string; properties?: any } } | undefined)?.payload
}

function isTerminalFinish(finish: string): boolean {
  // Mid-turn pauses that will be followed by more parts on the same message:
  if (finish === "tool-calls") return false
  return true
}

function extractUsage(info: any): MessageUsage | undefined {
  if (!info) return undefined
  const model =
    typeof info.providerID === "string" && typeof info.modelID === "string"
      ? `${info.providerID}/${info.modelID}`
      : undefined
  if (!model && info.cost === undefined && !info.tokens) return undefined
  return {
    model,
    cost: typeof info.cost === "number" ? info.cost : undefined,
    tokens: info.tokens
      ? {
          input: info.tokens.input ?? 0,
          output: info.tokens.output ?? 0,
          reasoning: info.tokens.reasoning ?? 0,
        }
      : undefined,
  }
}
