/**
 * Status state machine for the semantic index. Surfaced to the webview via
 * `Outbound.indexStatus`. The states are intentionally coarse — Phase 6's
 * scaffold doesn't yet have the per-file progress that the doc gestures at.
 */
export type IndexState = "disabled" | "idle" | "scanning" | "ready" | "error"

export type IndexStatus = {
  state: IndexState
  /** Number of indexed chunks. Undefined when not applicable. */
  chunks?: number
  /** Optional message — populated for `error` and useful for `disabled`. */
  message?: string
  /** Last-update timestamp (epoch ms). */
  updatedAt: number
}

export const INITIAL_STATUS: IndexStatus = {
  state: "disabled",
  updatedAt: 0,
}
