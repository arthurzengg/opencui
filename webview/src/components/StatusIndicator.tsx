/**
 * Small marker (coloured dot) + optional label, locked together so they
 * always sit on the same visual line.
 *
 * Why a dedicated component instead of rendering the dot + label as
 * siblings of whatever parent needs them: flex parents centre each child
 * by its own box centre, which makes a small (8 px) dot look detached
 * from the larger text glyph next to it. Inside this component the two
 * pieces share an inline line-box and align via `vertical-align: middle`,
 * which centres by font x-height (the perceived text midpoint). Callers
 * just place a `<StatusIndicator …>` and never see the alignment seams.
 */

export type StatusIndicatorKind = "default" | "ok" | "warn" | "err" | "pending"

type Props = {
  /** Drives the dot colour. `pending` additionally animates a pulse. */
  kind: StatusIndicatorKind
  /** Optional inline label shown to the right of the dot. */
  label?: string
  /** Native tooltip applied to the wrapper. */
  title?: string
}

export function StatusIndicator({ kind, label, title }: Props) {
  return (
    <span className="status-indicator" title={title}>
      <span className={`status-indicator-dot ${kind}`} />
      {label && <span className="status-indicator-label">{label}</span>}
    </span>
  )
}
