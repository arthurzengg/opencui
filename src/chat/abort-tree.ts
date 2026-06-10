import type { Backend } from "../server"
import { log } from "../output"

/**
 * State for one Stop generation. `aborted` dedupes `session.abort` calls
 * across every sweep in the generation (the initial sweep plus all drain
 * passes); `isLive` lets a sweep abandon work the moment the generation is
 * superseded (the user pressed Stop again or started a new turn).
 */
export interface AbortSweepState {
  aborted: Set<string>
  isLive: () => boolean
}

/**
 * One breadth-first pass over the session subtree rooted at `rootID`,
 * aborting every session not already aborted this generation. Returns the
 * number of sessions newly aborted in this pass. `seed` lets the caller
 * inject child IDs known to the tracker that may not yet show up in
 * `session.children`.
 *
 * Traversal is gated on `state.aborted` itself: a session aborted this
 * generation is neither re-aborted NOR re-listed, so a re-sweep over a
 * fully swept tree terminates at the root and touches nothing. This is
 * deliberate (and a revert of #317's visited/aborted split): a sweep that
 * re-listed children of aborted nodes kept shooting down every session
 * that appeared under the root for the whole drain window — opencode's
 * own post-abort children (title/summary/compaction agents) and follow-up
 * work started through paths that don't bump the generation. Stop must be
 * one volley, then silence.
 */
export async function sweepAbortTree(
  client: Backend["client"],
  rootID: string,
  seed: string[],
  state: AbortSweepState,
): Promise<number> {
  let newlyAborted = 0
  const queue = [rootID, ...seed]
  while (queue.length) {
    if (!state.isLive()) break
    const id = queue.shift()!
    if (state.aborted.has(id)) continue
    state.aborted.add(id)
    newlyAborted++
    try {
      await client.session.abort({ path: { id } })
    } catch (e) {
      log("session.abort failed", id, e)
    }
    try {
      const res = await client.session.children({ path: { id } })
      for (const child of res.data ?? []) {
        if (child?.id && !state.aborted.has(child.id)) queue.push(child.id)
      }
    } catch (e) {
      log("session.children failed", id, e)
    }
  }
  return newlyAborted
}

/**
 * Bounded re-sweep safety net carried over from the original design. With
 * traversal gated on `state.aborted`, a pass after a COMPLETE initial sweep
 * stops at the already-aborted root and returns 0 immediately — the drain
 * only matters for sessions seeded late into a sweep that was still
 * mid-walk. It must never become a window that aborts sessions spawned
 * after Stop (see `sweepAbortTree`).
 */
export async function drainAbortTree(
  client: Backend["client"],
  rootID: string,
  state: AbortSweepState,
  opts: { passes: number; intervalMs: number },
): Promise<void> {
  for (let i = 0; i < opts.passes && state.isLive(); i++) {
    await delay(opts.intervalMs)
    if (!state.isLive()) return
    const found = await sweepAbortTree(client, rootID, [], state)
    if (found === 0) return
    log(`[abort] drain pass ${i + 1} aborted ${found} late session(s)`)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
