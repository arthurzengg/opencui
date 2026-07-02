import { useEffect, useRef } from "react"
import type { ChatState, QueuedMessage } from "./useChatState"

type FlushState = Pick<ChatState, "idleNonce" | "queued" | "aborting" | "continuationPending">

/**
 * Auto-send queued messages when the session goes idle. Keyed on `idleNonce`
 * (one flush per `sessionIdle` event) instead of watching `busy`, which
 * flickers false between assistant messages inside a single turn — a
 * busy-based flush would inject the queued prompt mid-turn. One message per
 * idle: the flushed prompt starts a new turn, and the NEXT idle flushes the
 * next queued message.
 *
 * `deliver` both unqueues and sends; it runs at most once per nonce, so the
 * unqueue dispatch re-rendering with a shorter queue cannot double-fire.
 */
export function useQueueFlush(state: FlushState, deliver: (message: QueuedMessage) => void) {
  // Initialized to the mount-time nonce so a freshly (re)mounted webview
  // never flushes on an idle it did not observe.
  const lastFlushedNonce = useRef(state.idleNonce)
  useEffect(() => {
    if (state.idleNonce === lastFlushedNonce.current) return
    lastFlushedNonce.current = state.idleNonce
    // Defensive: sessionIdle clears both flags in the same reducer action,
    // but a host that ever posts them in another order must not leak a
    // queued prompt into an abort drain or a pending continuation.
    if (state.aborting || state.continuationPending) return
    const next = state.queued[0]
    if (!next) return
    deliver(next)
    // Deps are the nonce alone: queue mutations at the same nonce (enqueue,
    // manual remove) must not start a turn.
  }, [state.idleNonce])
}
