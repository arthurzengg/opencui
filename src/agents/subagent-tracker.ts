import { log } from "../output"
import type { Backend } from "../server"
import type { ChildSessionEvent, ChildSessionInfo, ToolUpdate } from "../chat/stream"
import {
  type AgentTask,
  type AgentTaskModel,
  type AgentTaskStore,
  classifyTerminal,
  subagentTaskID,
  subagentTaskIDByChildSession,
} from "./task-store"

/**
 * Set of tool names that count as "dispatching a subagent". Mirrors
 * `TARGET_TOOLS2` in oh-my-opencode source. Kept in sync with
 * `SUBAGENT_TOOLS` in `chat/view.ts` — the export there is the public
 * spelling used by tests; this internal copy avoids a circular import
 * between view.ts and this file.
 */
const SUBAGENT_DISPATCH_TOOLS: ReadonlySet<string> = new Set([
  "task",
  "Task",
  "task_tool",
  "delegate_task",
  "call_omo_agent",
  "background_task",
])

export type SubagentSubscription = {
  addChildSession: (sessionID: string) => void
  removeChildSession: (sessionID: string) => void
}

export type SubagentTrackerDeps = {
  store: AgentTaskStore
  /**
   * Reads the conversationID + parent sessionID at the moment of
   * mutation. Pulled lazily because both can change while a tracker
   * instance is alive (the user can switch conversations); a stale
   * snapshot here is what causes ghost rows in the popover.
   */
  getActiveConversationID: () => string
  /** May be `undefined` between session creation and first tool dispatch. */
  getParentSessionID: () => string | undefined
  /**
   * The stream subscription's child-session registration mutators.
   * Decoupled from `stream.Subscription` so unit tests can pass a tiny
   * stub instead of standing up a full SSE pipeline.
   */
  subscription: SubagentSubscription
}

/**
 * Per-callID memory of what we've already learned about a subagent
 * dispatch. Required because opencode emits multiple `tool.part.updated`
 * events for the same callID (initial `running`, post-metadata
 * `running`, terminal `completed`); we need to know whether we already
 * have a child sessionID so we don't keep re-registering it with the
 * subscription on every event.
 */
type DispatchState = {
  callID: string
  taskID: string
  childSessionID?: string
}

/**
 * Per-conversation subagent state machine. Decoupled from `ChatView` so
 * we can test the state transitions in isolation without spinning up
 * the whole webview-host wiring.
 *
 * Lifecycle (Hephaestus / Sisyphus background-dispatch is the
 * worst case, so the comment walks through that):
 *
 *   1. Parent's `task` tool part flips to `running` →
 *      `handleToolUpdate` upserts an AgentTask keyed by callID with
 *      status `running`. We don't know the child sessionID yet.
 *   2. omo's `publishToolMetadata` causes a second `tool.part.updated`
 *      whose `state.metadata` carries `sessionId` / `backgroundTaskId`
 *      / `agent` / `model` / `run_in_background`. We re-key the task
 *      to `subagent:child:<childSessionID>`, copy the metadata onto
 *      the record, and `addChildSession()` so the SSE router starts
 *      forwarding the child's events.
 *   3. Child session starts emitting `message.updated` /
 *      `message.part.*` events → `handleChildSessionEvent` keeps the
 *      task on `running` (refreshes `updatedAt`).
 *   4. Parent's `task` tool part flips to `completed` →
 *      `handleToolUpdate` IGNORES the terminal status when we have a
 *      live child sessionID (background tasks return their task_id
 *      immediately even though the child is still working). Without
 *      a child sessionID — i.e. opencode without omo, or a
 *      foreground call that didn't publish metadata — we honor the
 *      parent's terminal status as before.
 *   5. Child session emits `session.idle` →
 *      `handleChildSessionEvent` marks the task `completed` and
 *      `removeChildSession()` drops it from the interest set.
 *
 * Reconciliation (`reconcile()`) handles the dropped-VS-Code-instance
 * case: any task left in `running`/`waiting` from a prior session is
 * checked against `/session/status` and either resumed (added back to
 * the interest set) or settled.
 */
export class SubagentTracker {
  private readonly store: AgentTaskStore
  private readonly subscription: SubagentSubscription
  private readonly getConversationID: () => string
  private readonly getParentSessionID: () => string | undefined
  private readonly dispatches = new Map<string, DispatchState>()

  constructor(deps: SubagentTrackerDeps) {
    this.store = deps.store
    this.subscription = deps.subscription
    this.getConversationID = deps.getActiveConversationID
    this.getParentSessionID = deps.getParentSessionID
  }

  static isSubagentDispatchTool(toolName: string): boolean {
    return SUBAGENT_DISPATCH_TOOLS.has(toolName)
  }

  /**
   * Called from `ChatView.onTool` for every tool transition. Filters
   * to dispatch tools and updates the AgentTask accordingly.
   */
  async handleToolUpdate(update: ToolUpdate, messageID?: string): Promise<void> {
    if (!SUBAGENT_DISPATCH_TOOLS.has(update.tool)) return
    const parentSessionID = this.getParentSessionID()
    if (!parentSessionID) {
      log(`[subagent-tracker] skip ${update.tool}:${update.callID} — no parent sessionID yet`)
      return
    }
    const conversationID = this.getConversationID()
    const meta = readMetadata(update.metadata)
    // Opencode's built-in `task` tool puts the agent slug into
    // `input.subagent_type` rather than `metadata.agent`, so fall back to
    // the input when omo-style metadata is missing.
    if (!meta.subagent && update.input && typeof update.input === "object") {
      const input = update.input as Record<string, unknown>
      const fromInput =
        readStr(input.subagent_type) ?? readStr(input.subagent) ?? readStr(input.agent)
      if (fromInput) meta.subagent = fromInput
    }

    let dispatch = this.dispatches.get(update.callID)
    const isFirstSighting = !dispatch
    if (!dispatch) {
      // First sighting of this callID — pre-register with the callID-based
      // identity. The promote step below moves it to the child-session
      // identity once metadata arrives.
      dispatch = {
        callID: update.callID,
        taskID: subagentTaskID(parentSessionID, update.callID),
      }
      this.dispatches.set(update.callID, dispatch)
    }

    if (meta.childSessionID && !dispatch.childSessionID) {
      dispatch = await this.promoteToChildSessionIdentity(dispatch, meta.childSessionID, parentSessionID)
    }

    // If this is the FIRST tool event for a callID AND we have no
    // metadata.sessionId yet (opencode's built-in `task` tool path), check
    // whether `registerChildSession` already created an unclaimed placeholder
    // for a child whose `parentID` matches us. If exactly one orphan exists,
    // it MUST belong to this dispatch — opencode dispatches subagents
    // serially within a single tool call, so a unique unclaimed child plus a
    // unique fresh dispatch is an unambiguous link. Merging them here
    // prevents the duplicate row the user reported (one keyed by callID,
    // one keyed by child sessionID).
    if (isFirstSighting && !dispatch.childSessionID) {
      const orphanChildID = this.findOrphanChildSessionID(parentSessionID)
      if (orphanChildID) {
        dispatch = await this.promoteToChildSessionIdentity(dispatch, orphanChildID, parentSessionID)
      }
    }

    const now = Date.now()
    const existing = this.store.get(dispatch.taskID)
    const merged = mergeMetadata(existing, meta)

    if (update.status === "running" || update.status === "pending") {
      const next: AgentTask = {
        id: dispatch.taskID,
        kind: "subagent",
        conversationID,
        sessionID: parentSessionID,
        messageID,
        callID: update.callID,
        childSessionID: dispatch.childSessionID,
        backgroundTaskID: merged.backgroundTaskID,
        subagent: merged.subagent,
        category: merged.category,
        model: merged.model,
        runInBackground: merged.runInBackground,
        title: titleForDispatch(update, merged),
        status: "running",
        startedAt: existing?.startedAt ?? now,
        updatedAt: now,
      }
      await this.store.upsert(next)
      log(
        `[subagent-tracker] running ${dispatch.taskID} child=${dispatch.childSessionID ?? "(unknown)"} bg=${merged.runInBackground ?? false} agent=${merged.subagent ?? "?"}`,
      )
      return
    }

    if (update.status === "completed" || update.status === "error") {
      // Background dispatches (omo's `background_task`, or `call_omo_agent`
      // with `run_in_background: true`) return their task_id immediately
      // while the child keeps working — the parent's terminal status is
      // NOT authoritative there, and we must wait on the child's own
      // `session.idle` (via handleChildSessionEvent).
      //
      // Foreground dispatches (opencode's built-in `task`, `call_omo_agent`
      // for deep agents like Hephaestus → Sisyphus) only flip to
      // terminal AFTER the subagent has finished producing its result —
      // the parent's terminal status IS authoritative. The earlier
      // "any childSessionID" gate was leaving these stuck on `running`
      // forever (the foreground child's `session.idle` may have fired
      // before we registered the child sessionID, or never fired at all
      // when omo keeps the session warm for resume).
      const isBackground =
        merged.runInBackground === true || update.tool === "background_task"
      if (dispatch.childSessionID && isBackground) {
        // Still refresh metadata + agent/model in case the terminal
        // event carries fresher values, but keep status running.
        await this.store.update(dispatch.taskID, {
          backgroundTaskID: merged.backgroundTaskID,
          subagent: merged.subagent,
          category: merged.category,
          model: merged.model,
          runInBackground: merged.runInBackground,
          title: titleForDispatch(update, merged),
          updatedAt: now,
        })
        log(
          `[subagent-tracker] parent dispatch ${dispatch.taskID} terminal=${update.status} ignored (background child ${dispatch.childSessionID} owns lifecycle)`,
        )
        return
      }

      const classified =
        update.status === "error"
          ? classifyTerminal(update.error)
          : { status: "completed" as const, error: undefined }
      await this.store.update(dispatch.taskID, {
        status: classified.status,
        error: classified.error,
        updatedAt: now,
      })
      // If we had registered the child session with the SSE subscription,
      // drop it now — the parent has signalled the subagent is done, and
      // any late child events are stale.
      if (dispatch.childSessionID) {
        this.subscription.removeChildSession(dispatch.childSessionID)
      }
      this.dispatches.delete(update.callID)
      log(
        `[subagent-tracker] ${dispatch.taskID} settled ${classified.status} via parent terminal (child=${dispatch.childSessionID ?? "none"})`,
      )
    }
  }

  /**
   * Forwarded by `ChatView`'s subscription `onChildSessionEvent`. Maps
   * a child session lifecycle event onto the corresponding AgentTask.
   */
  async handleChildSessionEvent(event: ChildSessionEvent): Promise<void> {
    const taskID = subagentTaskIDByChildSession(event.sessionID)
    const existing = this.store.get(taskID)
    if (!existing) {
      // We may receive child events before the parent's tool update
      // metadata has been processed (rare; SSE order is best-effort).
      // Drop silently — the parent tool update will create the record
      // and the next child event will land on it.
      log(`[subagent-tracker] child event ${event.type} for unknown ${event.sessionID}`)
      return
    }
    const now = Date.now()
    switch (event.type) {
      case "busy":
        // Refresh updatedAt but don't bounce a terminal task back to
        // running — once errored/completed, a stray busy is ignored.
        if (existing.status === "error" || existing.status === "completed" || existing.status === "cancelled") {
          return
        }
        await this.store.update(taskID, { status: "running", updatedAt: now })
        return
      case "idle":
        // Final state. Drop the child session from the interest set so
        // the subscription doesn't keep routing its future events
        // (some plugins keep sessions warm for resume).
        if (existing.status === "completed" || existing.status === "error" || existing.status === "cancelled") {
          return
        }
        await this.store.update(taskID, { status: "completed", updatedAt: now })
        this.subscription.removeChildSession(event.sessionID)
        this.forgetCallIDsFor(taskID)
        log(`[subagent-tracker] ${taskID} child idle → completed`)
        return
      case "error": {
        const classified = classifyTerminal(event.message)
        await this.store.update(taskID, {
          status: classified.status,
          error: classified.error,
          updatedAt: now,
        })
        this.subscription.removeChildSession(event.sessionID)
        this.forgetCallIDsFor(taskID)
        log(`[subagent-tracker] ${taskID} child error → ${classified.status} (${event.message ?? "no message"})`)
        return
      }
      case "assistantEnd":
        if (event.error) {
          const classified = classifyTerminal(event.error)
          await this.store.update(taskID, {
            status: classified.status,
            error: classified.error,
            updatedAt: now,
          })
          this.subscription.removeChildSession(event.sessionID)
          this.forgetCallIDsFor(taskID)
        } else if (event.usage?.model && !existing.model) {
          // Backfill model from the assistant message when omo's
          // metadata didn't carry one (defensive — every omo path I
          // traced does publish `model`, but opencode's built-in
          // `task` tool may not).
          const [providerID, modelID] = event.usage.model.split("/")
          if (providerID && modelID) {
            await this.store.update(taskID, {
              model: { providerID, modelID },
              updatedAt: now,
            })
          }
        }
        return
    }
  }

  /**
   * Called when the SSE layer discovered a new child session for our parent
   * via `session.created` / `session.updated`. Creates a placeholder
   * AgentTask if we don't already have one for this child — this is the
   * fallback for cases where the parent's task tool doesn't surface
   * `metadata.sessionId` (opencode's built-in `task` tool, for one). When
   * the parent's tool metadata DOES arrive later, the existing record gets
   * merged with the richer info.
   */
  async registerChildSession(info: ChildSessionInfo): Promise<void> {
    const parentSessionID = this.getParentSessionID()
    if (!parentSessionID) return
    if (info.parentID !== parentSessionID) return
    const conversationID = this.getConversationID()
    const taskID = subagentTaskIDByChildSession(info.id)
    const existing = this.store.get(taskID)
    const now = Date.now()
    if (existing) {
      // Already known — refresh updatedAt only.
      await this.store.update(taskID, { updatedAt: now })
      return
    }
    // If the parent's `task` tool dispatch already created a callID-keyed row
    // and is sitting waiting on a child sessionID, promote it now rather than
    // creating a second row. The "exactly one unclaimed dispatch" guard
    // mirrors `handleToolUpdate`'s claim logic — serial dispatch means a
    // unique unclaimed dispatch must be this child.
    const orphanDispatch = this.findOrphanDispatch()
    if (orphanDispatch) {
      await this.promoteToChildSessionIdentity(orphanDispatch, info.id, parentSessionID)
      return
    }
    await this.store.upsert({
      id: taskID,
      kind: "subagent",
      conversationID,
      sessionID: parentSessionID,
      childSessionID: info.id,
      title: info.title?.trim() ? info.title.trim() : "Subagent",
      status: "running",
      startedAt: now,
      updatedAt: now,
    })
  }

  /**
   * Find a callID-based dispatch that hasn't been linked to a child session
   * yet. Returns one only when EXACTLY one orphan exists — ambiguous cases
   * (parallel subagent fan-out) skip the claim and let the metadata-based
   * path settle them later when sessionId publishing eventually happens.
   */
  private findOrphanDispatch(): DispatchState | undefined {
    const orphans = [...this.dispatches.values()].filter((d) => !d.childSessionID)
    return orphans.length === 1 ? orphans[0] : undefined
  }

  /**
   * Find a `registerChildSession`-created placeholder task (kind=subagent,
   * has childSessionID, no callID, still active) belonging to `parentSessionID`.
   * Used by `handleToolUpdate` to merge with a discovery placeholder rather
   * than creating a duplicate callID-keyed row.
   */
  private findOrphanChildSessionID(parentSessionID: string): string | undefined {
    const candidates = this.store.list().filter(
      (t) =>
        t.kind === "subagent" &&
        t.sessionID === parentSessionID &&
        !!t.childSessionID &&
        !t.callID &&
        (t.status === "running" || t.status === "waiting"),
    )
    return candidates.length === 1 ? candidates[0]!.childSessionID : undefined
  }

  /**
   * Walk the store at attach time to settle stale rows and re-register
   * still-alive child sessions with the new subscription. Called once
   * per `attachSubscription` in `ChatView` so a reload doesn't leave
   * subagent rows stuck on "running" forever.
   *
   * The reconcile call doesn't fail loudly — `/session/status` is
   * best-effort, and stale rows are better than wrongly-completed
   * rows. Failures are logged and the tracker proceeds.
   */
  async reconcile(backend: Backend, parentSessionID: string): Promise<void> {
    const conversationID = this.getConversationID()
    // Snapshot synchronously at attach time: rows a new turn creates AFTER
    // this point (fresh Main row, fresh dispatches) are never candidates,
    // so the late-resolving status fetch below can't wrongly settle them.
    const candidates = this.store
      .list()
      .filter(
        (t) =>
          (t.kind === "subagent" || t.kind === "main") &&
          t.conversationID === conversationID &&
          t.sessionID === parentSessionID &&
          (t.status === "running" || t.status === "waiting"),
      )
    if (candidates.length === 0) return
    let statuses: Record<string, { type?: string } | undefined> = {}
    try {
      const res = await backend.client.session.status({
        query: { directory: backend.directory },
      })
      statuses = (res?.data ?? {}) as Record<string, { type?: string } | undefined>
    } catch (e) {
      log("[subagent-tracker] reconcile session.status failed", e)
      return
    }
    const now = Date.now()
    for (const task of candidates) {
      if (task.kind === "main") {
        // A stale Main row only settles via its own session.idle — which a
        // reload mid-turn may have swallowed. If the parent is idle (or
        // forgotten), settle it here; if it's still busy, the live turn's
        // session.idle will do it.
        const parentStatus = statuses[parentSessionID]
        if (!parentStatus || parentStatus.type === "idle") {
          await this.store.update(task.id, { status: "completed", updatedAt: now })
          log(`[subagent-tracker] reconcile ${task.id} main row, parent idle/absent → completed`)
        }
        continue
      }
      if (!task.childSessionID) {
        // callID-keyed row from before the reload/switch. The in-memory
        // dispatch map that could ever update it is gone, and markSessionIdle
        // is main-only — nothing can settle it later. Close it out now.
        await this.store.update(task.id, { status: "completed", updatedAt: now })
        log(`[subagent-tracker] reconcile ${task.id} callID-keyed orphan → completed`)
        continue
      }
      const childSid = task.childSessionID
      const childStatus = statuses[childSid]
      if (!childStatus) {
        // Server has no record of this session — it ended (or was
        // never visible to this directory). Treat as completed.
        await this.store.update(task.id, { status: "completed", updatedAt: now })
        log(`[subagent-tracker] reconcile ${task.id} child ${childSid} not present → completed`)
        continue
      }
      if (childStatus.type === "idle") {
        await this.store.update(task.id, { status: "completed", updatedAt: now })
        log(`[subagent-tracker] reconcile ${task.id} child ${childSid} idle → completed`)
        continue
      }
      // Child is still busy — register it with the new subscription so
      // we resume tracking it from here on.
      this.subscription.addChildSession(childSid)
      log(`[subagent-tracker] reconcile ${task.id} child ${childSid} still ${childStatus.type ?? "?"} — resumed tracking`)
    }
  }

  /** Drop in-memory dispatch state — called on conversation switch. */
  reset(): void {
    this.dispatches.clear()
  }

  /**
   * Tear down every subagent the tracker holds for `parentSessionID`:
   *
   *   - Unregister each child sessionID from the SSE subscription so
   *     late events (a child whose `session.error` arrived after we
   *     locally settled the row) stop being routed.
   *   - Forget the corresponding callIDs in `dispatches` so a fresh
   *     dispatch with a reused callID can register cleanly.
   *   - Delegate the actual status mutation to
   *     `AgentTaskStore.cancelSessionTasks`, which handles both the
   *     subagent rows we just cleaned up AND any main row for the
   *     session (`recordMainTaskFinish` in `abortCurrent` usually
   *     beats us here, but doing it again is idempotent).
   *
   * Returns the list of child sessionIDs that were active at the
   * moment of teardown. `ChatView.abortCurrent` seeds its session-tree
   * sweep with these so a just-spawned child that the tracker knows
   * about but `session.children` hasn't surfaced yet is still aborted.
   */
  async cancelForSession(parentSessionID: string): Promise<string[]> {
    const active = this.store.activeSubagentsForSession(parentSessionID)
    const childSessionIDs: string[] = []
    for (const task of active) {
      if (task.childSessionID) {
        this.subscription.removeChildSession(task.childSessionID)
        childSessionIDs.push(task.childSessionID)
      }
      this.forgetCallIDsFor(task.id)
    }
    await this.store.cancelSessionTasks(parentSessionID)
    return childSessionIDs
  }

  private async promoteToChildSessionIdentity(
    dispatch: DispatchState,
    childSessionID: string,
    parentSessionID: string,
  ): Promise<DispatchState> {
    const oldID = dispatch.taskID
    const newID = subagentTaskIDByChildSession(childSessionID)
    if (oldID === newID) {
      dispatch.childSessionID = childSessionID
      this.subscription.addChildSession(childSessionID)
      return dispatch
    }
    const oldTask = this.store.get(oldID)
    // If a row already exists under the child-session id (task_id
    // reuse: Hephaestus resumed an existing subagent), we merge into
    // it rather than creating a duplicate.
    const existingChildTask = this.store.get(newID)
    if (oldTask) {
      if (existingChildTask) {
        // Both rows exist — the old (callID-based) row is the new
        // duplicate; carry forward its messageID/callID and drop the
        // old key. We do this by clearing the old row.
        await this.store.clear(oldID)
        // existingChildTask gets a fresh updatedAt + messageID on the
        // next upsert through handleToolUpdate (called shortly after
        // by the same SSE event chain).
      } else {
        // Atomically re-key: write the new id, then drop the old.
        // (AgentTaskStore has no rename API; clear+upsert is the
        // smallest surface change.)
        const next: AgentTask = {
          ...oldTask,
          id: newID,
          childSessionID,
          sessionID: parentSessionID,
        }
        await this.store.upsert(next)
        await this.store.clear(oldID)
      }
    }
    dispatch.taskID = newID
    dispatch.childSessionID = childSessionID
    this.subscription.addChildSession(childSessionID)
    return dispatch
  }

  private forgetCallIDsFor(taskID: string): void {
    for (const [callID, state] of this.dispatches) {
      if (state.taskID === taskID) this.dispatches.delete(callID)
    }
  }
}

type ReadMetadata = {
  childSessionID?: string
  backgroundTaskID?: string
  subagent?: string
  category?: string
  model?: AgentTaskModel
  runInBackground?: boolean
  description?: string
}

export function readMetadata(metadata: Record<string, unknown> | undefined): ReadMetadata {
  if (!metadata) return {}
  // omo writes both `sessionId` and `taskId`; opencode itself uses
  // camelCase too. We accept any common spelling so this works even if
  // a future omo refactor renames fields.
  const childSessionID = readStr(metadata.sessionId) ?? readStr(metadata.sessionID) ?? readStr(metadata.session_id) ?? readStr(metadata.taskId) ?? readStr(metadata.taskID) ?? readStr(metadata.task_id)
  const backgroundTaskID = readStr(metadata.backgroundTaskId) ?? readStr(metadata.backgroundTaskID) ?? readStr(metadata.background_task_id)
  const subagent = readStr(metadata.agent) ?? readStr(metadata.subagent) ?? readStr(metadata.subagent_type)
  const category = readStr(metadata.category)
  const description = readStr(metadata.description)
  const runInBackgroundRaw = metadata.run_in_background ?? metadata.runInBackground
  const runInBackground = typeof runInBackgroundRaw === "boolean" ? runInBackgroundRaw : undefined
  return {
    childSessionID,
    backgroundTaskID,
    subagent,
    category,
    description,
    runInBackground,
    model: readModel(metadata.model),
  }
}

function readStr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function readModel(value: unknown): AgentTaskModel | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  const providerID = readStr(obj.providerID) ?? readStr(obj.providerId) ?? readStr(obj.provider_id)
  const modelID = readStr(obj.modelID) ?? readStr(obj.modelId) ?? readStr(obj.model_id)
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

type Merged = {
  backgroundTaskID?: string
  subagent?: string
  category?: string
  model?: AgentTaskModel
  runInBackground?: boolean
  description?: string
}

function mergeMetadata(existing: AgentTask | undefined, meta: ReadMetadata): Merged {
  // "Fresh wins" for every scalar field — the metadata stream evolves
  // (omo can publish multiple times during execution to add things
  // like fallback model swaps), but `existing` is the previous truth
  // for fields we haven't re-learned in this event.
  return {
    backgroundTaskID: meta.backgroundTaskID ?? existing?.backgroundTaskID,
    subagent: meta.subagent ?? existing?.subagent,
    category: meta.category ?? existing?.category,
    model: meta.model ?? existing?.model,
    runInBackground: meta.runInBackground ?? existing?.runInBackground,
    description: meta.description,
  }
}

function titleForDispatch(update: ToolUpdate, merged: Merged): string {
  // Same precedence as the legacy `taskTitleFromUpdate`: explicit
  // description (from input or metadata) → tool's own title → fallback.
  const input = update.input
  if (input && typeof input === "object") {
    const desc = (input as Record<string, unknown>).description
    if (typeof desc === "string" && desc.trim()) return desc.trim()
  }
  if (merged.description) return merged.description
  if (update.title && update.title.trim()) return update.title.trim()
  if (merged.subagent) return `Subagent: ${merged.subagent}`
  return "Background agent"
}
