import { useEffect, useRef, useState } from "react"

/**
 * Shared open/close state for the inline popover menus in the status bar
 * (Model/Agent selector, Agents pill, Chat history). Owns the `useState`,
 * the ref for the outer container, and the pointerdown + Escape listeners
 * that dismiss the popover when the user clicks outside or hits Escape.
 *
 * The caller still renders its own trigger and popover JSX; only the
 * boilerplate moves in here. Attach the returned `ref` to the outermost
 * container (the same element the popover is positioned relative to) so
 * the outside-click check can tell "still inside" from "elsewhere".
 */
export function useDismissableMenu(): {
  open: boolean
  setOpen: (value: boolean) => void
  toggle: () => void
  close: () => void
  ref: React.RefObject<HTMLDivElement>
} {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  return {
    open,
    setOpen,
    toggle: () => setOpen(!open),
    close: () => setOpen(false),
    ref,
  }
}
