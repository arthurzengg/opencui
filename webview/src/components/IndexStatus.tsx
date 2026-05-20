import type { IndexStatusInfo } from "../protocol"

type Props = {
  status?: IndexStatusInfo
  onStart?: () => void
  onStop?: () => void
}

const STATE_LABELS: Record<IndexStatusInfo["state"], string> = {
  disabled: "Disabled",
  idle: "Idle",
  scanning: "Scanning",
  ready: "Ready",
  error: "Error",
}

/**
 * Tiny status pill for the semantic index. Phase 6 ships with `none`
 * provider only — the pill shows whether the user has flipped the setting
 * on and lets them trigger a (re)scan. Real progress bars + per-file
 * counts arrive when a follow-up wires an actual embedding provider.
 */
export function IndexStatus({ status, onStart, onStop }: Props) {
  if (!status) return null
  const label = STATE_LABELS[status.state]
  const canStart = status.state === "disabled" || status.state === "idle" || status.state === "error"
  const canStop = status.state === "scanning" || status.state === "ready"
  return (
    <div className={`index-status state-${status.state}`} title={status.message ?? label}>
      <span className="index-status-dot" aria-hidden />
      <span className="index-status-label">Index · {label}</span>
      {typeof status.chunks === "number" && status.state === "ready" && (
        <span className="index-status-meta">{status.chunks} chunks</span>
      )}
      {canStart && onStart && (
        <button type="button" className="index-status-action" onClick={onStart}>
          {status.state === "error" ? "Retry" : "Scan"}
        </button>
      )}
      {canStop && onStop && (
        <button type="button" className="index-status-action" onClick={onStop}>
          Stop
        </button>
      )}
    </div>
  )
}
