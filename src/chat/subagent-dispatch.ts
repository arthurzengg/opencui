import { log } from "../output"
import { AgentTaskStore, mainTaskID } from "../agents/task-store"
import { SubagentTracker } from "../agents/subagent-tracker"
import type { ToolUpdate } from "./stream"

/**
 * Reduce a user prompt to a short title for the Agents popover. Lives
 * here because `recordMainTaskStart` is the only host-side caller.
 */
export function summarizePrompt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 64) || "Main agent"
}

/**
 * Owns the per-turn main-task lifecycle in the AgentTaskStore and
 * bridges SSE tool events into the SubagentTracker. ChatView still owns
 * `messageMap` / `messages` (deeply woven through the reducer and
 * stream handlers) and continues to handle webview-id minting +
 * subagent-block placement directly — those touch state that crosses
 * many other subsystems, so extracting them would just trade
 * callbacks-in for callbacks-out.
 */
export class SubagentDispatch {
  /**
   * Full task-store ID of the main task for the turn currently in flight.
   * Minted at `recordMainTaskStart` and used by `recordMainTaskFinish` so
   * a follow-up turn in the same session doesn't try to mutate the
   * previous turn's terminal main row. Cleared in `clearMainTaskID()` by
   * ChatView at conversation boundaries / dispose / abort.
   */
  private currentMainTaskID?: string
  private tracker?: SubagentTracker

  constructor(
    private deps: {
      taskStore?: AgentTaskStore
      getSessionID: () => string | undefined
      getActiveConversationID: () => string
      collapseToGraceIfSettled: () => void
    },
  ) {}

  /**
   * ChatView constructs the SubagentTracker lazily inside
   * `attachSubscription` (the SSE subscription's `addChildSession` /
   * `removeChildSession` are the wiring it depends on). Pass it through
   * here once it exists so the dispatcher's tool forwarding picks it up.
   */
  setTracker(tracker: SubagentTracker | undefined): void {
    this.tracker = tracker
  }

  clearMainTaskID(): void {
    this.currentMainTaskID = undefined
  }

  activeSubagentCount(): number {
    const sessionID = this.deps.getSessionID()
    if (!this.deps.taskStore || !sessionID) return 0
    // Resumed (task_id-reuse) children have terminal store rows but are
    // genuinely working again — the tracker holds them in memory only.
    const resumed = this.tracker?.resumedActiveCount() ?? 0
    return this.deps.taskStore.activeSubagentsForSession(sessionID).length + resumed
  }

  /**
   * Bridge from the SSE `onTool` callback to the SubagentTracker. The
   * tracker is the single source of truth for subagent records — view.ts
   * only owns the main-task lifecycle. When a subagent settles while a
   * continuation defer is open, ask continuationState to collapse to
   * the short post-settle grace window so the UI doesn't sit at
   * "Continuing…" forever waiting on a follow-up that never comes.
   *
   * Tracked tools live in `SubagentTracker.isSubagentDispatchTool()` —
   * see the omo source notes there.
   */
  async forwardTool(update: ToolUpdate, messageID: string | undefined): Promise<void> {
    if (!this.tracker) return
    if (!SubagentTracker.isSubagentDispatchTool(update.tool)) return
    log(`[agents-status] tool event tool=${update.tool} status=${update.status} callID=${update.callID}`)
    await this.tracker.handleToolUpdate(update, messageID)
    this.deps.collapseToGraceIfSettled()
  }

  async recordMainTaskStart(text: string): Promise<void> {
    if (!this.deps.taskStore) {
      log("[agents-status] recordMainTaskStart skipped — no taskStore wired")
      return
    }
    const sessionID = this.deps.getSessionID()
    if (!sessionID) {
      log("[agents-status] recordMainTaskStart skipped — no sessionID yet")
      return
    }
    const conversationID = this.deps.getActiveConversationID()
    // A failed prior turn stays visible in the popover only until the next
    // turn starts — clear it now, or the terminal error row lingers forever.
    await this.deps.taskStore.clearErrored(conversationID)
    const turnID = crypto.randomUUID()
    const id = mainTaskID(conversationID, sessionID, turnID)
    const now = Date.now()
    this.currentMainTaskID = id
    log(`[agents-status] recordMainTaskStart ${id}`)
    await this.deps.taskStore.upsert({
      id,
      kind: "main",
      conversationID,
      sessionID,
      title: summarizePrompt(text),
      status: "running",
      startedAt: now,
      updatedAt: now,
    })
  }

  async recordMainTaskFinish(
    status: "completed" | "error" | "cancelled",
    error?: string,
  ): Promise<void> {
    if (!this.deps.taskStore) return
    const id = this.currentMainTaskID
    if (!id) return
    this.currentMainTaskID = undefined
    await this.deps.taskStore.update(id, {
      status,
      error,
      updatedAt: Date.now(),
    })
  }

  /**
   * Flip the current turn's Main row between `running` and `waiting`.
   * Driven by ChatView's pending permission/question count — "waiting"
   * means opencode is blocked on the user's answer, which is exactly when
   * the popover should stop claiming work is running. Only the two
   * expected transitions are applied (running → waiting, waiting →
   * running); a settled row keeps its terminal status and a stray call
   * after the turn ended no-ops on the cleared `currentMainTaskID`.
   */
  async setMainWaiting(waiting: boolean): Promise<void> {
    if (!this.deps.taskStore) return
    const id = this.currentMainTaskID
    if (!id) return
    const existing = this.deps.taskStore.get(id)
    if (!existing) return
    const from = waiting ? "running" : "waiting"
    if (existing.status !== from) return
    await this.deps.taskStore.update(id, {
      status: waiting ? "waiting" : "running",
      updatedAt: Date.now(),
    })
  }
}
