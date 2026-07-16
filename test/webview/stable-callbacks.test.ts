import { describe, it, expect } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useChatState } from "../../webview/src/hooks/useChatState"

describe("useChatState callback stability", () => {
  it("keeps every API method identity-stable across state updates", () => {
    const { result } = renderHook(() => useChatState())
    const before = { ...result.current }

    // queueMessage dispatches, so the reducer produces new state and the
    // component re-renders — the exact situation that used to mint fresh
    // callbacks (and re-fire searchFiles/listDir effects downstream).
    act(() => {
      result.current.queueMessage("queued while busy")
    })
    expect(result.current.state.queued).toHaveLength(1)
    expect(result.current.state).not.toBe(before.state)

    for (const key of Object.keys(before) as Array<keyof typeof before>) {
      if (key === "state") continue
      expect(result.current[key], `${String(key)} changed identity across renders`).toBe(before[key])
    }
  })
})
