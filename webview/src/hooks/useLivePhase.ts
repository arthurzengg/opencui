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

/** Period of the light that crosses the live line; mirrors `--thinking-sweep-period` in styles.css. */
export const THINKING_SWEEP_MS = 2400

/**
 * The same shared clock for the light on the live line (#798). The line under
 * a sent prompt, the reply that takes it over, and each new title are
 * different elements; without a common phase the light would start again at
 * every one of them. `element` names the element the style is for, so the
 * phase is taken again when a new one is drawn. It travels in a custom
 * property, not an inline animation-delay: the label can carry a second
 * animation (its words arriving), and an inline delay would apply to both.
 */
export function useSweepPhase(active: boolean, element: unknown): CSSProperties | undefined {
  return useMemo(
    () => (active ? ({ "--sweep-phase": `${-Math.round(performance.now() % THINKING_SWEEP_MS)}ms` } as CSSProperties) : undefined),
    [active, element],
  )
}
