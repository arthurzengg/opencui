import { useMemo, type CSSProperties } from "react"

/** Period shared by every running-state indicator; mirrors `--live-breathe-period` in styles.css. */
export const LIVE_BREATHE_MS = 1600

/**
 * A negative animation delay that drops an element into the shared breathing
 * cycle at the phase the clock is at right now (#621). A CSS animation starts
 * from its own element's start time, so without this, indicators that appear
 * at different moments breathe out of step even at the same period.
 */
export function livePhaseStyle(now: number = performance.now()): CSSProperties {
  return { animationDelay: `${-Math.round(now % LIVE_BREATHE_MS)}ms` }
}

/** The phase style, taken when `active` turns true so it matches the animation's own start. */
export function useLivePhase(active: boolean): CSSProperties | undefined {
  return useMemo(() => (active ? livePhaseStyle() : undefined), [active])
}
