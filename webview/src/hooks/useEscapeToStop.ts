import { useEffect, useRef } from "react"

/**
 * Esc anywhere in the panel stops the running turn — but only as the last
 * resort. Every dismissable layer (prompt pickers, header popovers, the
 * image preview, the rename input, a highlighted mention chip) consumes its
 * Escape with `preventDefault()` from a handler that fires before this
 * window-level bubble listener (React handlers at the root container,
 * document-level listeners), so an open layer closes and the turn keeps
 * running; the NEXT Esc stops it.
 *
 * The listener only exists while `active` (a turn is running and not
 * already aborting), so idle Esc presses cost nothing and "Stopping…"
 * cannot double-post an abort.
 */
export function useEscapeToStop(active: boolean, stop: () => void) {
  // `stop` comes from a per-render object literal in useChatState; track it
  // in a ref so the listener isn't torn down and re-added every render.
  const stopRef = useRef(stop)
  stopRef.current = stop
  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      // Esc during IME composition cancels the composition, not the turn.
      // keyCode 229 is the legacy fallback for older Chromium builds.
      if (e.isComposing || e.keyCode === 229) return
      stopRef.current()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [active])
}
