import type { QueuedMessage } from "../hooks/useChatState"

type Props = {
  queued: QueuedMessage[]
  onRemove: (id: string) => void
}

/**
 * Messages typed while a turn was running, waiting to auto-send on the next
 * session idle. Rendered inside the bottom dock just above the composer so
 * the dock's ResizeObserver reserves scroll padding for it automatically.
 */
export function QueuedMessages({ queued, onRemove }: Props) {
  if (queued.length === 0) return null
  return (
    <div className="queued-messages" role="list" aria-label="Queued messages">
      {queued.map((q) => (
        <div className="queued-row" role="listitem" key={q.id} title={q.text}>
          <span className="queued-badge">Queued</span>
          <span className="queued-text">{queuedLabel(q)}</span>
          <button
            type="button"
            className="queued-remove"
            aria-label="Remove queued message"
            title="Remove queued message"
            onClick={() => onRemove(q.id)}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}

function queuedLabel(q: QueuedMessage): string {
  const count = q.attachments?.length ?? 0
  const suffix = count === 0 ? "" : count === 1 ? " · 1 attachment" : ` · ${count} attachments`
  if (!q.text) return suffix ? suffix.slice(3) : ""
  return q.text + suffix
}
