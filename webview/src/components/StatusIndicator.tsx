/**
 * Coloured marker dot. The colour IS the message — the human-readable
 * status rides along as a native tooltip so the header stays a single
 * glyph wide in a narrow sidebar.
 */

export type StatusIndicatorKind = "default" | "ok" | "warn" | "err" | "pending"

type Props = {
  /** Drives the dot colour. `pending` additionally animates a pulse. */
  kind: StatusIndicatorKind
  /** Native tooltip — the only place the status text is shown. */
  title?: string
}

export function StatusIndicator({ kind, title }: Props) {
  return <span className={`status-indicator-dot ${kind}`} title={title} />
}
