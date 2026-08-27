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

describe("running tool row elapsed time (#561)", () => {
  it("shows plain 'running' inside the grace period", () => {
    render(<ToolTrace updates={[bash("running")]} />)
    advance(1000)
    expect(screen.getByText("running")).toBeTruthy()
    expect(screen.queryByText(/·/)).toBeNull()
  })

  it("ticks an elapsed suffix past the grace period", () => {
    render(<ToolTrace updates={[bash("running")]} />)
    advance(3000)
    expect(screen.getByText("running · 3s")).toBeTruthy()
    advance(1000)
    expect(screen.getByText("running · 4s")).toBeTruthy()
  })

  it("formats long runs through formatElapsed", () => {
    render(<ToolTrace updates={[bash("running")]} />)
    advance(75_000)
    expect(screen.getByText("running · 1m")).toBeTruthy()
  })

  it("drops the marker entirely when the tool completes", () => {
    const { rerender } = render(<ToolTrace updates={[bash("running")]} />)
    advance(5000)
    expect(screen.getByText("running · 5s")).toBeTruthy()
    rerender(<ToolTrace updates={[bash("completed")]} />)
    expect(screen.queryByText(/running/)).toBeNull()
  })

  it("does not count pending time toward the clock", () => {
    // A tool can sit `pending` (e.g. awaiting a permission decision) long
    // before it starts; the clock must measure running time only.
    const { rerender } = render(<ToolTrace updates={[bash("pending")]} />)
    advance(10_000)
    rerender(<ToolTrace updates={[bash("running")]} />)
    advance(2000)
    expect(screen.getByText("running · 2s")).toBeTruthy()
  })

  it("applies the same treatment to a running edit row", () => {
    render(<ToolTrace updates={[edit("running")]} />)
    advance(1000)
    expect(screen.getByText("running")).toBeTruthy()
    advance(4000)
    expect(screen.getByText("running · 5s")).toBeTruthy()
  })
})
