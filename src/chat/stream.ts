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

export type QuestionOption = {
  label: string
  description: string
}

export type QuestionInfo = {
  question: string
  header: string
  options: QuestionOption[]
  /** Allow selecting multiple options (default false). */
  multiple?: boolean
  /** Allow typing a custom free-text answer (default true). */
  custom?: boolean
}

export type QuestionRequest = {
  id: string
  sessionID: string
  questions: QuestionInfo[]
}

export type Toast = {
  title?: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  /** Hint in milliseconds; we don't enforce this on the host side. */
  duration?: number
}

export type MessageUsage = {
  model?: string
  providerID?: string
  modelID?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cacheRead?: number; cacheWrite?: number }
}

export type StreamHandlers = {
  /** Fired when the SSE connection is open and subscribed. */
  onReady?: () => void
  /** Fired when a new user message is observed for this session. */
  onUserMessage?: (messageID: string) => void
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
  onQuestionAsked?: (question: QuestionRequest) => void
  /** Fired when a question is answered (by us or another client) or rejected. */
  onQuestionResolved?: (requestID: string) => void
  /**
   * Fired when opencode removes a message from the session (revert, redo,
   * internal truncation). Lets the webview drop a still-pending row that
   * would otherwise sit there as a ghost "Working…" indicator.
   */
  onMessageRemoved?: (messageID: string) => void
  /** Fired for opencode toasts (`tui.toast.show`). */
  onToast?: (toast: Toast) => void
  onSessionError?: (message: string) => void
  onSessionIdle?: () => void
  onSessionBusy?: () => void
  /**
   * Optional second routing branch for child (subagent) sessions. The
   * SSE stream is process-wide (`client.global.event()` returns every
   * session's events), so we can listen for child-session lifecycle
   * without opening a second connection — subscribers register child
   * sessionIDs via `Subscription.addChildSession()` and the events
   * arrive here. `messageInfo` only flows for assistant-role
   * `message.updated` events; the rest are pure lifecycle signals.
   */
  onChildSessionEvent?: (event: ChildSessionEvent) => void
  /**
   * Fired when a `session.created` (or `session.updated`) event arrives
   * for a session whose `parentID` matches our parent — i.e. a subagent
   * spawned by our session. Subscribers can `addChildSession(info.id)` so
   * subsequent tool/patch events get routed to `onChildSessionEvent`.
   *
   * Why this exists: opencode's built-in `task` tool dispatches a child
   * session but doesn't always surface `metadata.sessionId` on the parent's
   * tool call early enough to register the child via the metadata-based
   * promotion path in `SubagentTracker`. Listening for `session.created`
   * with a matching parent is a stricter signal — it fires the moment the
   * subagent's session record is written, so we never miss its events.
   */
  onChildSessionDiscovered?: (info: ChildSessionInfo) => void
  onSessionTitleUpdate?: (title: string) => void
}

export type ChildSessionInfo = {
  id: string
  parentID: string
  title?: string
}

/**
 * Events surfaced to `onChildSessionEvent` for sessions registered via
 * `Subscription.addChildSession()`. Modeled after the minimum the
 * subagent tracker + review aggregator need to mirror a child session's
 * lifecycle and file changes onto the parent's chat record:
 *   - `busy` — first sign the child session has started executing
 *   - `idle` — child session reports it has nothing in flight
 *   - `error` — child session reported an opencode-side session error
 *   - `assistantEnd` — final assistant message with optional usage
 *     (so the tracker can pick up model + token usage on completion)
 *   - `tool` — terminal tool transition on the child. Carries the full
 *     ToolUpdate so subagent file edits feed into the Review Panel via
 *     the same path as parent tool blocks.
 *   - `patch` — child emitted an `apply_patch`/patch part. Same usage as
 *     `tool` but for whole-tree diffs.
 */
export type ChildSessionEvent =
  | { type: "busy"; sessionID: string }
  | { type: "idle"; sessionID: string }
  | { type: "error"; sessionID: string; message: string }
  | {
      type: "assistantEnd"
      sessionID: string
      messageID: string
      finish?: string
      usage?: MessageUsage
      error?: string
    }
  | {
      type: "tool"
      sessionID: string
      messageID: string
      update: ToolUpdate
    }
  | {
      type: "patch"
      sessionID: string
      messageID: string
      files: string[]
      diff?: string
    }

export type Subscription = {
  ready: Promise<void>
  abort: () => void
  /**
   * Register a child sessionID we want lifecycle events for. Re-adding
   * the same id is a no-op. Use `removeChildSession()` once the
   * tracker is done with it; staying subscribed past completion is
   * harmless (the child session simply stops emitting), but the
   * tracker uses removal to bound its internal map.
   */
  addChildSession: (sessionID: string) => void
  removeChildSession: (sessionID: string) => void
}

export type SubscriptionOptions = {
  /**
   * Watchdog interval. If no SSE events arrive for this many milliseconds
   * while we believe the session is busy, the host actively polls
   * `/session/status` to recover from a dropped/missed `session.idle`.
   * Defaults to 30 s; tests pass shorter values.
   */
  watchdogMs?: number
}

const DEFAULT_WATCHDOG_MS = 30_000

/**
 * Long-lived subscription to session events. Does NOT close on message finish —
 * stays open until abort() is called. This lets the UI capture follow-up
 * assistant turns that are auto-triggered by background-task reminders,
 * permission replies, or any other opencode-side continuation.
 *
 * Recovery: a watchdog timer arms while the session is observed busy and
 * resets on every routed event. If the timer fires (no SSE events for
 * `watchdogMs`), the host calls `client.session.status({ directory })`
 * directly — if opencode reports idle, we emit `onSessionIdle` ourselves.
 * Without this, a dropped SSE connection at the wrong moment leaves the
 * UI permanently in "Working…".
 */
export function subscribeSession(
  backend: Backend,
  sessionID: string,
  handlers: StreamHandlers,
  options: SubscriptionOptions = {},
): Subscription {
  const controller = new AbortController()
  const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS

  const seenLen = new Map<string, number>()
  const seenAssistantMessages = new Set<string>()
  const seenUserMessages = new Set<string>()
  const assistantFinished = new Set<string>()
  const toolStatus = new Map<string, string>()
  const seenPatches = new Set<string>()
  /**
   * Sessions we additionally route lifecycle events for (subagent
   * children). Distinct from the parent `sessionID` because parent
   * routing has rich per-message handlers; child routing only needs
   * the small `ChildSessionEvent` surface.
   */
  const childSessions = new Set<string>()
  /** assistantEnd dedup for child sessions (parent has its own set). */
  const childAssistantFinished = new Set<string>()

  // messageID → set of tool part IDs that are still pending/running.
  // Used to defer per-message `assistantEnd` until all tool calls terminate:
  // some providers return `finish: "stop"` while the message still has
  // running tool parts, so the finish reason alone isn't sufficient.
  const activeToolParts = new Map<string, Set<string>>()
  // messageID → payload waiting on tool-part completion before assistantEnd fires.
  const pendingFinish = new Map<string, { finish: string; usage?: MessageUsage }>()

  let watchdogTimer: ReturnType<typeof setTimeout> | null = null
  let busyTracked = false
  let stopped = false

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
    // First, fan child-session events off to the subagent tracker (if
    // any registered). We do this BEFORE the parent-session switch so
    // events for sessions in both sets (unlikely, but possible) are
    // observed by both branches.
    routeChildSessionEvent(type, props)
    // Session-created / -updated with a matching parentID is our cue that
    // opencode just spawned a subagent. Notify the host so it can register
    // the child for routing — even if the parent's `task` tool metadata
    // never publishes the child sessionID, we still capture the child's
    // tool/patch events.
    if ((type === "session.created" || type === "session.updated") && handlers.onChildSessionDiscovered) {
      const info = props?.info
      if (info && typeof info === "object" && typeof info.id === "string" && info.parentID === sessionID) {
        handlers.onChildSessionDiscovered({
          id: info.id,
          parentID: info.parentID,
          title: typeof info.title === "string" ? info.title : undefined,
        })
      }
    }
    switch (type) {
      case "message.updated":
        onMessageUpdated(props?.info)
        markActivity(props?.info?.sessionID)
        return
      case "message.part.updated":
        onPartUpdated(props?.part)
        markActivity(props?.part?.sessionID)
        return
      case "message.part.delta":
        onPartDelta(props)
        markActivity(props?.sessionID)
        return
      case "permission.asked":
      case "permission.updated":
        onPermissionUpdated(props)
        markActivity(props?.sessionID)
        return
      case "question.asked":
        onQuestionAsked(props)
        markActivity(props?.sessionID)
        return
      case "question.replied":
      case "question.rejected":
        onQuestionResolved(props)
        markActivity(props?.sessionID)
        return
      case "message.removed":
        onMessageRemoved(props)
        markActivity(props?.sessionID)
        return
      case "tui.toast.show":
        return onToast(props)
      case "session.error":
        return onSessionError(props?.error, props?.sessionID)
      case "session.idle":
        if (props?.sessionID === sessionID) markIdle()
        return
      case "session.status":
        if (props?.sessionID !== sessionID) return
        if (props?.status?.type === "idle") {
          markIdle()
        } else if (props?.status?.type) {
          handlers.onSessionBusy?.()
          markActivity(sessionID)
        }
        return
      case "session.created":
        return
      case "session.updated": {
        const info = props?.info
        if (
          info && typeof info === "object" &&
          info.id === sessionID &&
          typeof info.title === "string" && info.title
        ) {
          handlers.onSessionTitleUpdate?.(info.title)
        }
        return
      }
      case "server.connected":
      case "server.heartbeat":
      case "session.next.agent.switched":
      case "session.next.model.switched":
      case "session.diff":
      case "project.updated":
      case "file.watcher.updated":
      case "sync":
        // Known opencode events we intentionally don't route. Listed
        // explicitly (instead of falling through to `default`) so the
        // output channel doesn't flood with `unhandled type:` lines for
        // every tick of routine opencode chatter.
        return
      default:
        // Unknown opencode event type — log so a new SDK event surfaces
        // in the output channel instead of silently vanishing. Add a
        // matching `case` above to actually route it (or to silence it,
        // if it's expected noise like the cases just above).
        log(`[sse] unhandled type: ${type}`)
        return
    }
  }

  function routeChildSessionEvent(type: string, props: any) {
    const childCb = handlers.onChildSessionEvent
    if (!childCb || childSessions.size === 0) return
    const childSid = extractSessionID(type, props)
    if (!childSid || !childSessions.has(childSid)) return
    switch (type) {
      case "session.idle":
        childCb({ type: "idle", sessionID: childSid })
        return
      case "session.status":
        if (props?.status?.type === "idle") {
          childCb({ type: "idle", sessionID: childSid })
        } else if (props?.status?.type) {
          childCb({ type: "busy", sessionID: childSid })
        }
        return
      case "session.error":
        childCb({
          type: "error",
          sessionID: childSid,
          message: props?.error?.data?.message ?? props?.error?.name ?? "session error",
        })
        return
      case "message.updated":
        // A child assistant message that just finished — surface usage
        // and any terminal error to the tracker. Also doubles as a
        // "subagent is alive" signal for busy detection.
        if (props?.info?.role === "assistant") {
          childCb({ type: "busy", sessionID: childSid })
          const mid = props.info.id as string | undefined
          if (!mid) return
          const dedupKey = `${childSid}|${mid}`
          if (props.info.error && !childAssistantFinished.has(dedupKey)) {
            childAssistantFinished.add(dedupKey)
            const err = props.info.error as { name?: string; data?: { message?: string } }
            childCb({
              type: "assistantEnd",
              sessionID: childSid,
              messageID: mid,
              error: err.data?.message ?? err.name ?? "unknown error",
              finish: props.info.finish,
            })
            return
          }
          if (props.info.finish && isTerminalFinish(props.info.finish) && !childAssistantFinished.has(dedupKey)) {
            childAssistantFinished.add(dedupKey)
            childCb({
              type: "assistantEnd",
              sessionID: childSid,
              messageID: mid,
              finish: props.info.finish,
              usage: extractUsage(props.info),
            })
          }
        }
        return
      case "message.part.updated": {
        // Any activity on the child means it is busy. Cheap "still
        // alive" signal that complements `session.idle` for tracker
        // hysteresis.
        childCb({ type: "busy", sessionID: childSid })
        const part = props?.part
        if (!part || typeof part !== "object") return
        const messageID = typeof part.messageID === "string" ? part.messageID : undefined
        if (!messageID) return
        if (part.type === "tool" && part.callID && part.tool && part.state) {
          const status = part.state.status as ToolUpdate["status"]
          if (status === "completed" || status === "error") {
            childCb({
              type: "tool",
              sessionID: childSid,
              messageID,
              update: {
                callID: part.callID,
                tool: part.tool,
                status,
                title: part.state.title,
                input: part.state.input,
                metadata: part.state.metadata,
                output: part.state.output,
                error: part.state.error,
              },
            })
          }
          return
        }
        if (part.type === "patch" && Array.isArray(part.files)) {
          childCb({
            type: "patch",
            sessionID: childSid,
            messageID,
            files: part.files,
            diff: typeof part.diff === "string" ? part.diff : undefined,
          })
        }
        return
      }
      case "message.part.delta":
        childCb({ type: "busy", sessionID: childSid })
        return
      case "session.updated":
      case "session.created":
      case "message.removed":
        // Routine child-session chatter we don't act on. Silent so the
        // output channel stays readable — same contract as the parent
        // route's known-no-op cases above.
        return
      default:
        // Unknown event for a tracked child session — log and drop. Same
        // contract as the parent route's default branch.
        log(`[sse:child:${childSid}] unhandled type: ${type}`)
        return
    }
  }

  function extractSessionID(type: string, props: any): string | undefined {
    if (!props || typeof props !== "object") return undefined
    if (type === "message.updated") return props?.info?.sessionID
    if (type === "message.part.updated") return props?.part?.sessionID
    return props?.sessionID
  }

  function markActivity(eventSessionID: string | undefined) {
    if (eventSessionID !== sessionID) return
    busyTracked = true
    armWatchdog()
  }

  function markIdle() {
    busyTracked = false
    clearWatchdog()
    handlers.onSessionIdle?.()
  }

  function clearWatchdog() {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
  }

  function armWatchdog() {
    clearWatchdog()
    if (!busyTracked || stopped) return
    watchdogTimer = setTimeout(runWatchdog, watchdogMs)
  }

  async function runWatchdog() {
    watchdogTimer = null
    if (stopped || !busyTracked) return
    log(`[watchdog] no SSE events for ${watchdogMs}ms, polling /session/status`)
    try {
      const result = await backend.client.session.status({
        query: { directory: backend.directory },
      })
      if (stopped) return
      const statuses = (result?.data ?? {}) as Record<string, { type?: string } | undefined>
      const status = statuses[sessionID]
      if (!status || status.type === "idle") {
        log("[watchdog] server reports idle — emitting onSessionIdle")
        markIdle()
        return
      }
      log(`[watchdog] server reports ${status.type} — re-arming`)
      armWatchdog()
    } catch (err) {
      if (stopped) return
      log("[watchdog] poll failed, re-arming", err)
      armWatchdog()
    }
  }

  function onMessageUpdated(info: any) {
    if (!info || info.sessionID !== sessionID) return
    if (info.role === "user") {
      const uid = info.id as string | undefined
      if (uid && !seenUserMessages.has(uid)) {
        seenUserMessages.add(uid)
        handlers.onUserMessage?.(uid)
      }
      return
    }
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
        // Some providers return `finish: "stop"` while the assistant message
        // still has running tool parts — opencode's own loop-exit check
        // (packages/opencode/src/session/prompt.ts) also gates on no active
        // tool calls. Mirror that here so we don't clear the spinner before
        // the tool parts settle.
        const active = activeToolParts.get(mid)
        if (active && active.size > 0) {
          pendingFinish.set(mid, { finish: info.finish, usage: extractUsage(info) })
          return
        }
        assistantFinished.add(mid)
        handlers.onAssistantEnd?.(mid, {
          finish: info.finish,
          usage: extractUsage(info),
        })
      }
    }
  }

  function maybeFlushPendingFinish(messageID: string) {
    if (assistantFinished.has(messageID)) return
    const active = activeToolParts.get(messageID)
    if (active && active.size > 0) return
    const pending = pendingFinish.get(messageID)
    if (!pending) return
    pendingFinish.delete(messageID)
    assistantFinished.add(messageID)
    handlers.onAssistantEnd?.(messageID, pending)
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
      // Track unfinished tool parts per message; flush a deferred
      // assistantEnd once everything settles.
      const partKey = (part.id as string | undefined) ?? key
      const isTerminal = curr === "completed" || curr === "error"
      const set = activeToolParts.get(messageID) ?? new Set<string>()
      if (isTerminal) {
        set.delete(partKey)
      } else {
        set.add(partKey)
      }
      if (set.size > 0) activeToolParts.set(messageID, set)
      else activeToolParts.delete(messageID)
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
      if (isTerminal) maybeFlushPendingFinish(messageID)
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

  function onQuestionAsked(p: any) {
    if (!p || p.sessionID !== sessionID) return
    handlers.onQuestionAsked?.({
      id: p.id,
      sessionID: p.sessionID,
      questions: Array.isArray(p.questions) ? p.questions : [],
    })
  }

  function onQuestionResolved(p: any) {
    if (!p || p.sessionID !== sessionID) return
    const id = p.requestID ?? p.id
    if (!id) return
    handlers.onQuestionResolved?.(id)
  }

  function onMessageRemoved(p: any) {
    if (!p || p.sessionID !== sessionID) return
    const id = p.messageID ?? p.id
    if (!id) return
    handlers.onMessageRemoved?.(id)
  }

  function onToast(p: any) {
    if (!p || typeof p.message !== "string") return
    const variant = ["info", "success", "warning", "error"].includes(p.variant) ? p.variant : "info"
    handlers.onToast?.({
      title: typeof p.title === "string" ? p.title : undefined,
      message: p.message,
      variant,
      duration: typeof p.duration === "number" ? p.duration : undefined,
    })
  }

  function onSessionError(err: any, eventSessionID?: string) {
    // session.error is global — only surface ones for our parent session
    // (child-session errors are already routed to onChildSessionEvent).
    if (eventSessionID && eventSessionID !== sessionID) return
    const msg = err?.data?.message ?? err?.name ?? "session error"
    handlers.onSessionError?.(msg)
  }

  return {
    ready,
    abort: () => {
      stopped = true
      clearWatchdog()
      controller.abort()
    },
    addChildSession: (id: string) => {
      childSessions.add(id)
    },
    removeChildSession: (id: string) => {
      childSessions.delete(id)
    },
  }
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
    providerID: typeof info.providerID === "string" ? info.providerID : undefined,
    modelID: typeof info.modelID === "string" ? info.modelID : undefined,
    cost: typeof info.cost === "number" ? info.cost : undefined,
    tokens: info.tokens
      ? {
          input: info.tokens.input ?? 0,
          output: info.tokens.output ?? 0,
          reasoning: info.tokens.reasoning ?? 0,
          cacheRead: info.tokens.cache?.read ?? 0,
          cacheWrite: info.tokens.cache?.write ?? 0,
        }
      : undefined,
  }
}
