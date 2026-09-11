import { describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import { LIVE_BREATHE_MS, livePhaseStyle, useLivePhase } from "../../webview/src/hooks/useLivePhase"

describe("livePhaseStyle (#621)", () => {
  it("joins the shared cycle at the current phase", () => {
    expect(livePhaseStyle(5000)).toEqual({ animationDelay: "-200ms" })
    expect(livePhaseStyle(2 * LIVE_BREATHE_MS)).toEqual({ animationDelay: "0ms" })
    expect(livePhaseStyle(LIVE_BREATHE_MS - 1)).toEqual({ animationDelay: "-1599ms" })
  })

  it("gives two elements started at the same moment the same phase", () => {
    expect(livePhaseStyle(123456.7)).toEqual(livePhaseStyle(123456.7))
  })
})

describe("useLivePhase", () => {
  it("is undefined while inactive and stable while active", () => {
    const { result, rerender } = renderHook(({ active }) => useLivePhase(active), {
      initialProps: { active: false },
    })
    expect(result.current).toBeUndefined()
    rerender({ active: true })
    const first = result.current
    expect(first?.animationDelay).toMatch(/^-?\d+ms$/)
    rerender({ active: true })
    expect(result.current).toBe(first)
    rerender({ active: false })
    expect(result.current).toBeUndefined()
  })
})
