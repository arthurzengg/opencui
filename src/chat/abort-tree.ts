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
 */
export async function sweepAbortTree(
  client: Backend["client"],
  rootID: string,
  seed: string[],
  state: AbortSweepState,
): Promise<number> {
  let newlyAborted = 0
  // Per-pass traversal guard, deliberately distinct from `state.aborted`:
  // drain passes must re-list children of already-aborted nodes to catch
  // sessions the orchestrator dispatched after the node was first aborted.
  // Gating traversal on `state.aborted` made every drain pass skip the root
  // and exit having seen nothing.
  const visited = new Set<string>()
  const queue = [rootID, ...seed]
  while (queue.length) {
    if (!state.isLive()) break
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    if (!state.aborted.has(id)) {
      state.aborted.add(id)
      newlyAborted++
      try {
        await client.session.abort({ path: { id } })
      } catch (e) {
        log("session.abort failed", id, e)
      }
    }
    try {
      const res = await client.session.children({ path: { id } })
      for (const child of res.data ?? []) {
        if (child?.id && !visited.has(child.id)) queue.push(child.id)
      }
    } catch (e) {
      log("session.children failed", id, e)
    }
  }
  return newlyAborted
}

/**
 * Re-sweep the subtree until a pass finds no new sessions, catching tasks
 * the orchestrator dispatches in the window after the initial sweep. Bounded
 * by iteration count and abandoned the moment the generation is superseded.
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
