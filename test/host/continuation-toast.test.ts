import { describe, it, expect } from "vitest"
import { isContinuationToast } from "../../src/chat/view"

describe("isContinuationToast", () => {
  it("matches omo TodoContinuationEnforcer toast", () => {
    expect(
      isContinuationToast({
        title: "Todo Continuation",
        message: "Resuming in 2s... (3 tasks remaining)",
        variant: "warning",
      }),
    ).toBe(true)
  })

  it("matches opencode auto-resume after background task complete", () => {
    expect(
      isContinuationToast({
        title: "Background task complete",
        message: 'Background task "explore" finished. Resuming the main thread.',
        variant: "success",
      }),
    ).toBe(true)
  })

  it("matches opencode auto-resume after background task failed", () => {
    expect(
      isContinuationToast({
        title: "Background task failed",
        message: 'Background task "librarian" failed. Resuming the main thread.',
        variant: "error",
      }),
    ).toBe(true)
  })

  it("matches omo task-toast-manager when a background subagent spawns", () => {
    expect(
      isContinuationToast({
        title: "New Background Task",
        message: 'starting "explore"',
        variant: "info",
      }),
    ).toBe(true)
  })

  it("matches a 'Resuming the main thread' message even with no relevant title", () => {
    expect(
      isContinuationToast({
        title: "Notice",
        message: "Resuming the main thread",
        variant: "info",
      }),
    ).toBe(true)
  })

  it("does not match generic 'Task Completed' toasts (ambiguous; not a wait signal)", () => {
    expect(
      isContinuationToast({
        title: "Task Completed",
        message: '"explore" finished in 12s',
        variant: "success",
      }),
    ).toBe(false)
  })

  it("does not match unrelated info toasts", () => {
    expect(
      isContinuationToast({
        title: "MCP Server",
        message: "connected; added 12 tools",
        variant: "info",
      }),
    ).toBe(false)
  })

  it("does not match toasts that only contain the word 'background' (no 'task')", () => {
    expect(
      isContinuationToast({
        title: "Background sync",
        message: "indexed 42 files",
        variant: "info",
      }),
    ).toBe(false)
  })
})
