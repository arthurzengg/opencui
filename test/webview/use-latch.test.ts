import { describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import { useLatch } from "../../webview/src/hooks/useLatch"

describe("useLatch (#680)", () => {
  function setup(key: string | null, on: boolean) {
    return renderHook(({ k, o }: { k: string | null; o: boolean }) => useLatch(k, o), { initialProps: { k: key, o: on } })
  }

  it("stays on after `on` was true once under the same key", () => {
    const { result, rerender } = setup("t1", false)
    expect(result.current).toBe(false)
    rerender({ k: "t1", o: true })
    expect(result.current).toBe(true)
    rerender({ k: "t1", o: false })
    expect(result.current).toBe(true)
  })

  it("starts over from the current `on` when the key changes", () => {
    const { result, rerender } = setup("t1", true)
    rerender({ k: "t2", o: false })
    expect(result.current).toBe(false)
    rerender({ k: "t2", o: false })
    expect(result.current).toBe(false)
    rerender({ k: "t3", o: true })
    expect(result.current).toBe(true)
  })

  it("drops through a null key and relatches on the way back", () => {
    const { result, rerender } = setup("t1", true)
    rerender({ k: null, o: false })
    expect(result.current).toBe(false)
    rerender({ k: "t1", o: false })
    expect(result.current).toBe(false)
    rerender({ k: "t1", o: true })
    expect(result.current).toBe(true)
  })
})
