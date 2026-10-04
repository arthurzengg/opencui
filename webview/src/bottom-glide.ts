type ScrollBox = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">
type Raf = (cb: FrameRequestCallback) => number

/**
 * Each frame closes 1 - e^(-dt / GLIDE_TAU_MS) of the remaining gap: a step
 * settles in about three time constants, and a steady stream settles into a
 * constant small lag instead of a staircase of jumps (#676).
 */
export const GLIDE_TAU_MS = 40
const FRAME_MS = 16

/**
 * Eases a scroller toward its bottom, one write per frame. The target is
 * re-read every frame, so content arriving mid-glide extends the glide rather
 * than queueing another. `box` returning null (following was dropped, the view
 * unmounted) ends it. The first step runs synchronously so the frame that
 * grew the content already starts moving.
 */
export function createBottomGlide(opts: {
  box: () => ScrollBox | null
  write: (top: number) => void
  raf?: Raf
  cancelRaf?: (id: number) => void
}) {
  const raf: Raf = opts.raf ?? ((cb) => requestAnimationFrame(cb))
  const cancelRaf = opts.cancelRaf ?? ((id: number) => cancelAnimationFrame(id))
  let frame: number | null = null
  let last: number | null = null

  const step = (now: number | null) => {
    frame = null
    const el = opts.box()
    if (!el) {
      last = null
      return
    }
    const gap = el.scrollHeight - el.clientHeight - el.scrollTop
    if (gap <= 1) {
      if (gap > 0) opts.write(el.scrollTop + gap)
      last = null
      return
    }
    const dt = now === null || last === null ? FRAME_MS : Math.min(Math.max(now - last, 1), 4 * FRAME_MS)
    last = now
    opts.write(el.scrollTop + Math.max(1, gap * (1 - Math.exp(-dt / GLIDE_TAU_MS))))
    frame = raf(step)
  }

  return {
    start() {
      if (frame === null) step(null)
    },
    stop() {
      if (frame !== null) cancelRaf(frame)
      frame = null
      last = null
    },
  }
}

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** An upward wheel over a nested scroller that can still scroll up is that scroller's, not the transcript's. */
export function nestedScrollerTakesWheelUp(target: EventTarget, container: Element): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== container; el = el.parentElement) {
    if (el.scrollTop > 0) return true
  }
  return false
}
