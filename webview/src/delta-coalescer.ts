import type { Action } from "./hooks/useChatState"

type Raf = (cb: () => void) => void

/**
 * Coalesces high-frequency streaming deltas into one dispatch burst per
 * animation frame. opencode posts each `textDelta`/`reasoningDelta` as its own
 * `postMessage`, and each becomes a separate React render; under a fast stream
 * that is the dominant render cost.
 *
 * Consecutive deltas for the SAME message id and kind are merged into one
 * action; every other action — and any delta for a different id/kind — is kept
 * in arrival order so a `tool`/`patch`/`assistantDone` that arrives mid-stream
 * still lands between the right text and is never reordered. React 18 batches
 * the per-frame dispatch loop into a single render.
 *
 * `raf` is injectable so tests can flush synchronously.
 */
export function createDeltaCoalescer(
  dispatch: (action: Action) => void,
  raf: Raf = (cb) => requestAnimationFrame(cb),
) {
  const queue: Action[] = []
  let scheduled = false

  function flush() {
    scheduled = false
    const batch = queue.splice(0)
    for (const action of batch) dispatch(action)
  }

  function enqueue(action: Action) {
    const last = queue[queue.length - 1]
    if (
      (action.type === "textDelta" || action.type === "reasoningDelta") &&
      last !== undefined &&
      last.type === action.type &&
      last.id === action.id
    ) {
      // Merge into a fresh object so we never mutate the original event.
      queue[queue.length - 1] = { ...last, delta: last.delta + action.delta }
    } else {
      queue.push(action)
    }
    if (!scheduled) {
      scheduled = true
      raf(flush)
    }
  }

  return { enqueue, flush }
}
