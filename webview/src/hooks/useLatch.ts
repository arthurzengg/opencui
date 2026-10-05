import { useState } from "react"

/**
 * True once `on` has been true at any render since `key` last changed. A key
 * change starts over from the current `on`, so a latch keyed by the turn
 * resets on a new prompt and one keyed by null is always off (#680).
 */
export function useLatch<K>(key: K, on: boolean): boolean {
  const [prevKey, setPrevKey] = useState(key)
  const [latched, setLatched] = useState(on)
  if (key !== prevKey) {
    setPrevKey(key)
    setLatched(on)
  } else if (on && !latched) {
    setLatched(true)
  }
  return key === prevKey ? latched || on : on
}
