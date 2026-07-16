import { useEffect, useRef, useState } from "react"

/**
 * Re-emit `value` at most once per `ms` (leading + trailing edge). `ms <= 0`
 * is a plain pass-through. Used to sample a streaming message's text before
 * the Markdown pipeline: parsing the whole growing text on every coalesced
 * frame is the expensive part, and ~20 fps is indistinguishable in a chat
 * bubble. The trailing emit guarantees the final text always lands even if
 * the last delta arrives mid-window.
 */
export function useThrottledValue<T>(value: T, ms: number): T {
  const [throttled, setThrottled] = useState(value)
  const lastEmit = useRef(0)
  const trailing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useRef(value)
  latest.current = value

  useEffect(() => {
    if (ms <= 0) {
      // Keep state in sync so a later switch to throttling starts current.
      setThrottled(value)
      return
    }
    const since = Date.now() - lastEmit.current
    if (since >= ms) {
      lastEmit.current = Date.now()
      setThrottled(value)
      return
    }
    trailing.current ??= setTimeout(() => {
      trailing.current = undefined
      lastEmit.current = Date.now()
      setThrottled(latest.current)
    }, ms - since)
  }, [value, ms])

  useEffect(
    () => () => {
      if (trailing.current) clearTimeout(trailing.current)
    },
    [],
  )

  return ms <= 0 ? value : throttled
}
