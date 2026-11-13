import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, render, screen, cleanup } from "@testing-library/react"
import { ToolTrace } from "../../webview/src/components/ToolCard"
import type { ToolUpdate } from "../../webview/src/protocol"

function bash(status: ToolUpdate["status"]): ToolUpdate {
  return { callID: "c1", tool: "bash", status, input: { command: "bun run test" } }
}

function edit(status: ToolUpdate["status"]): ToolUpdate {
  return {
    callID: "c2",
    tool: "edit",
    status,
    input: { filePath: "src/server.ts", oldString: "a", newString: "b" },
  }
}

beforeEach(() => {
  cleanup()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))

// A running row is marked by the spinner in its icon column, named "running"
// for assistive tech, and by its elapsed time once the grace period is over.
const spinner = () => screen.queryByRole("img", { name: "running" })
const elapsed = () => document.querySelector(".trace-elapsed")?.textContent

describe("running tool row elapsed time (#561)", () => {
  it("shows the spinner alone inside the grace period", () => {
    render(<ToolTrace tools={[{ update: bash("running") }]} />)
    advance(1000)
    expect(spinner()).toBeTruthy()
    expect(elapsed()).toBeUndefined()
  })

  it("ticks the elapsed time past the grace period", () => {
    render(<ToolTrace tools={[{ update: bash("running") }]} />)
    advance(3000)
    expect(elapsed()).toBe("3s")
    advance(1000)
    expect(elapsed()).toBe("4s")
  })

  it("formats long runs through formatElapsed", () => {
    render(<ToolTrace tools={[{ update: bash("running") }]} />)
    advance(75_000)
    expect(elapsed()).toBe("1m")
  })

  it("drops the spinner and the time when the tool completes", () => {
    const { rerender } = render(<ToolTrace tools={[{ update: bash("running") }]} />)
    advance(5000)
    expect(elapsed()).toBe("5s")
    rerender(<ToolTrace tools={[{ update: bash("completed") }]} />)
    expect(spinner()).toBeNull()
    expect(elapsed()).toBeUndefined()
  })

  it("does not count pending time toward the clock", () => {
    // A tool can sit `pending` (e.g. awaiting a permission decision) long
    // before it starts; the clock must measure running time only.
    const { rerender } = render(<ToolTrace tools={[{ update: bash("pending") }]} />)
    advance(10_000)
    expect(spinner()).toBeNull()
    rerender(<ToolTrace tools={[{ update: bash("running") }]} />)
    advance(2000)
    expect(elapsed()).toBe("2s")
  })

  it("applies the same treatment to a running edit row", () => {
    render(<ToolTrace tools={[{ update: edit("running") }]} />)
    advance(1000)
    expect(spinner()).toBeTruthy()
    expect(elapsed()).toBeUndefined()
    advance(4000)
    expect(elapsed()).toBe("5s")
  })
})
