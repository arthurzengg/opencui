/**
 * Coloured marker dot. The colour IS the message — the human-readable
 * status rides along as a native tooltip so the header stays a single
 * glyph wide in a narrow sidebar.
 */

import { useLivePhase } from "../hooks/useLivePhase"

export type StatusIndicatorKind = "default" | "ok" | "warn" | "err" | "pending"

type Props = {
  /** Drives the dot colour. `pending` additionally breathes on the shared clock (#621). */
  kind: StatusIndicatorKind
  /** Native tooltip — the only place the status text is shown. */
  title?: string
}

export function StatusIndicator({ kind, title }: Props) {
  const pending = kind === "pending"
  const phase = useLivePhase(pending)
  return (
    <span className={`status-indicator-dot ${kind}${pending ? " live-breathe" : ""}`} title={title} style={phase} />
  )
}
