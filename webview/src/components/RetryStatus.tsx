import { useEffect, useState } from "react"
import type { SessionRetryInfo } from "../protocol"

/** Whole seconds until `next`, re-evaluated once a second while mounted. */
function useCountdown(next: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const handle = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(handle)
  }, [next])
  return Math.max(0, Math.ceil((next - now) / 1000))
}

export function RetryStatus({ retry, onOpenLink }: { retry: SessionRetryInfo; onOpenLink?: (url: string) => void }) {
  const seconds = useCountdown(retry.next)
  const action = retry.action
  return (
    <div className="retry-status" role="status" aria-live="polite">
      <div className="retry-status-line">
        Retrying (attempt {retry.attempt}): {retry.message}
        {seconds > 0 && <span className="retry-status-next"> · next try in {seconds}s</span>}
      </div>
      {action && (
        <div className="retry-status-action">
          <strong>{action.title}.</strong> {action.message}
          {action.link && (
            <>
              {" "}
              <a
                href={action.link}
                onClick={(e) => {
                  // The webview swallows same-tab navigations; the host opens it.
                  e.preventDefault()
                  e.stopPropagation()
                  onOpenLink?.(action.link!)
                }}
              >
                {action.label}
              </a>
            </>
          )}
        </div>
      )}
    </div>
  )
}
