import { useEffect, useRef, useState } from "react"

type DismissableMenuOptions = {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * Shared open/close state for the inline popover menus in the status bar
 * (Model/Agent selector, Agents pill, Chat history). Owns either local
 * open state or a controlled open value, the ref for the outer container,
 * and the click + Escape listeners
 * that dismiss the popover when the user clicks outside or hits Escape.
 *
 * The caller still renders its own trigger and popover JSX; only the
 * boilerplate moves in here. Attach the returned `ref` to the outermost
 * container (the same element the popover is positioned relative to) so
 * the outside-click check can tell "still inside" from "elsewhere".
 */
export function useDismissableMenu(options: DismissableMenuOptions = {}): {
  open: boolean
  setOpen: (value: boolean) => void
  toggle: () => void
  close: () => void
  ref: React.RefObject<HTMLDivElement>
} {
  const [localOpen, setLocalOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const controlled = options.open !== undefined
  const open = controlled ? options.open! : localOpen
  const setOpen = (value: boolean) => {
    if (controlled) {
      options.onOpenChange?.(value)
      return
    }
    setLocalOpen(value)
  }

  useEffect(() => {
    if (!open) return
    // Close on the completed click rather than pointerdown. Header popovers
    // publish a height that pushes the sticky user bubble down; dismissing on
    // pointerdown can remove that height before the browser delivers the
    // bubble's click, so click-to-edit never sees the activation.
    const onClick = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    // Escape marks itself consumed and listens on `document` (which bubbles
    // BEFORE `window`) so the Esc-to-stop window listener sees
    // `defaultPrevented` and lets the popover close win over stopping the
    // running turn.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setOpen(false)
    }
    window.addEventListener("click", onClick)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("click", onClick)
      document.removeEventListener("keydown", onKeyDown)
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
