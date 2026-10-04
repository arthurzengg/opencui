import { describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import { useEntrance } from "../../webview/src/hooks/useEntrance"

describe("useEntrance (#670, #674)", () => {
  function setup(initial: string | null = null) {
    return renderHook(({ k }: { k: string | null }) => useEntrance(k), { initialProps: { k: initial } })
  }

  it("names the key that appeared while nothing was shown, for as long as it stays", () => {
    const { result, rerender } = setup()
    expect(result.current).toBeNull()
    rerender({ k: "a" })
    expect(result.current).toBe("a")
    rerender({ k: "a" })
    expect(result.current).toBe("a")
  })

  it("drops to null on a swap and stays there, even swapping back", () => {
    const { result, rerender } = setup()
    rerender({ k: "a" })
    rerender({ k: "b" })
    expect(result.current).toBeNull()
    rerender({ k: "a" })
    expect(result.current).toBeNull()
  })

  it("enters again after the surface has gone back to none", () => {
    const { result, rerender } = setup()
    rerender({ k: "a" })
    rerender({ k: "b" })
    rerender({ k: null })
    expect(result.current).toBeNull()
    rerender({ k: "b" })
    expect(result.current).toBe("b")
  })

  it("treats a key present on the first render as entering", () => {
    const { result } = setup("a")
    expect(result.current).toBe("a")
  })
})
