import type { Outbound } from "../protocol"
import { log } from "../output"

/**
 * Tracks the deferred-idle state for "this turn isn't really done, a
 * continuation is about to start" gating. Two sources keep a defer
 * open:
 *
 *  - **Structural**: live subagent tasks in the store. When the parent
 *    session goes idle but the children are still running (Hephaestus
 *    spawning Explore, omo dispatching Todo continuations), the
 *    structural gate keeps `continuationPending: true` until the
 *    children settle.
 *  - **Signal**: a toast-style hint (e.g. omo's TodoContinuationEnforcer
 *    countdown). Recognized by `isContinuationToast` in view.ts; routed
 *    here via `markSignal`. Caps at `DEFER_MS` so a missing follow-up
 *    can't pin the UI indefinitely.
 *
 * The class is a small state machine owning a single pending timer +
 * two flags. ChatView still drives the session-event integration; it
 * calls into this class via the methods below and listens for the
 * resulting `continuationPending` / `sessionIdle` posts.
 */
export class ContinuationState {
  private lastSignalAt = 0
  private pendingTimer?: ReturnType<typeof setTimeout>
  /**
   * True between `continuationPending: true` and either the deferred
   * `sessionIdle` firing, or a new `sessionBusy` / `assistantStart` /
   * abort cancelling the defer.
   */
  private deferActive = false

  private static readonly SIGNAL_TTL_MS = 30_000
  /**
   * Max wait for a *toast-only* continuation (no active subagent tasks
   * in the store) to materialize before declaring idle. Long enough to
   * absorb the lag between a parent's idle and an omo plugin injecting
   * its continuation toast. The structural variant (live subagent
   * tasks) has no fixed cap — it waits for the child sessions
   * themselves to terminate.
   */
  private static readonly DEFER_MS = 120_000
  /**
   * After the last running subagent task settles while we were
   * deferring, wait this long for a continuation toast / new turn to
   * arrive before clearing busy. Most omo / opencode wakeups fire
   * within a couple of seconds.
   */
  private static readonly GRACE_MS = 10_000

  constructor(
    private deps: {
      post: (msg: Outbound) => void
      activeSubagentCount: () => number
    },
  ) {}

  /**
   * Record a toast-style "continuation is imminent" hint. If we are
   * already in a *toast-only* defer (no active subagents) with the cap
   * timer running, restart the cap so a fresh signal extends the wait.
   * With omo, a Background-task-complete toast can arrive late into a
   * Todo-Continuation wait — we want to honour the newer signal rather
   * than time out on the older one.
   */
  markSignal(source: string): void {
    this.lastSignalAt = Date.now()
    log(`[continuation] signal observed (${source})`)
    if (this.deferActive && this.deps.activeSubagentCount() === 0 && this.pendingTimer) {
      this.scheduleIdleEmit(ContinuationState.DEFER_MS, "signal-re-arm")
    }
  }

  private hasRecentSignal(): boolean {
    return Date.now() - this.lastSignalAt < ContinuationState.SIGNAL_TTL_MS
  }

  /**
   * Should we defer the next `sessionIdle` because a continuation is
   * either in flight (live subagents) or about to begin (recent toast)?
   */
  hasGate(): boolean {
    return this.deps.activeSubagentCount() > 0 || this.hasRecentSignal()
  }

  private clearPending(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = undefined
    }
  }

  /**
   * Cancel any in-flight defer and tell the webview the pending state
   * is over. Used when a new turn starts (sessionBusy / assistantStart),
   * when abort takes over, or when we decide to clear busy ourselves.
   */
  finishPending(): void {
    this.clearPending()
    if (this.deferActive) {
      this.deferActive = false
      this.deps.post({ type: "continuationPending", pending: false })
    }
  }

  /**
   * Open a continuation defer. While there are any active subagents
   * for the parent session, no timer runs — we wait for child-session
   * idle events to drive the close. Otherwise (toast-only signal), a
   * cap timer prevents an indefinite wait if no continuation arrives.
   */
  beginDefer(source: string): void {
    this.clearPending()
    if (!this.deferActive) {
      this.deferActive = true
      this.deps.post({ type: "continuationPending", pending: true })
    }
    log(
      `[continuation] deferring sessionIdle (${source}, subagents=${this.deps.activeSubagentCount()}, signal=${this.hasRecentSignal()})`,
    )
    if (this.deps.activeSubagentCount() > 0) return
    this.scheduleIdleEmit(ContinuationState.DEFER_MS, "toast-cap")
  }

  /**
   * Schedule emission of `sessionIdle` after `delay`. On fire, if a
   * subagent has spun up again (or never settled), the timer no-ops —
   * tracker callbacks will re-schedule when subagents finally settle.
   */
  scheduleIdleEmit(delay: number, source: string): void {
    this.clearPending()
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined
      if (this.deps.activeSubagentCount() > 0) {
        log(`[continuation] timer (${source}) fired but subagents still active; staying deferred`)
        return
      }
      log(`[continuation] timer (${source}) resolved; emitting sessionIdle`)
      this.deferActive = false
      this.deps.post({ type: "continuationPending", pending: false })
      this.deps.post({ type: "sessionIdle" })
    }, delay)
  }

  /**
   * Called by ChatView when a subagent settles while a defer is open —
   * collapse to the short post-settle grace window so the UI doesn't
   * sit at "Continuing…" forever waiting on a follow-up that never
   * comes.
   */
  collapseToGraceIfSettled(): void {
    if (this.deferActive && this.deps.activeSubagentCount() === 0) {
      this.scheduleIdleEmit(ContinuationState.GRACE_MS, "subagents-settled")
    }
  }

  /** Clear all continuation tracking — used on conversation switch / dispose / abort tail. */
  reset(): void {
    this.clearPending()
    this.deferActive = false
    this.lastSignalAt = 0
  }
}
