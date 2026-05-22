import { useLayoutEffect, type RefObject } from "react"

/**
 * While `open` is true, observe `popoverRef`'s height and publish it as
 * `--header-popover-height` on document.documentElement. Used by the three
 * statusbar menus (Selector / Agents / History) so the sticky user-message
 * bubble (`.msg.role-user`) can shift down by that amount and not be
 * painted over by the popover.
 *
 * Only one popover is open at a time (StatusBar owns one active-popover
 * state), so a single shared variable is enough.
 */
export function useHeaderPopoverHeight(
  open: boolean,
  popoverRef: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    if (!open) return
    const el = popoverRef.current
    if (!el) return
    const update = () => {
      const h = Math.round(el.getBoundingClientRect().height)
      document.documentElement.style.setProperty("--header-popover-height", `${h}px`)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      ro.disconnect()
      document.documentElement.style.removeProperty("--header-popover-height")
    }
  }, [open, popoverRef])
}
