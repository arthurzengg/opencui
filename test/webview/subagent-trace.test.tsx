import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { ToolTrace } from "../../webview/src/components/ToolCard"
import type { ReviewChangeActor, ToolUpdate } from "../../webview/src/protocol"

afterEach(cleanup)

const explore: ReviewChangeActor = { kind: "subagent", sessionID: "ses_child", subagent: "explore", callID: "call_task" }

function update(callID: string, tool: string, input: Record<string, unknown>, status: ToolUpdate["status"] = "completed"): ToolUpdate {
  return { callID, tool, status, input }
}

describe("ToolTrace with subagent work", () => {
  it("nests a child session's calls under the row that dispatched it and keeps them out of the parent's rows", () => {
    const { container } = render(
      <ToolTrace
        tools={[
          { update: update("c_main", "read", { filePath: "src/foo.ts" }) },
          { update: update("call_task", "task", { description: "Find the subscription" }, "running") },
          { update: update("c1", "read", { filePath: "src/foo.ts" }), actor: explore },
          { update: update("c2", "read", { filePath: "src/bar.ts" }), actor: explore },
          { update: update("c3", "grep", { pattern: "subscribe" }), actor: explore },
        ]}
      />,
    )
    // The parent's reads line counts its own read alone, although the child read the same file.
    expect(container.querySelector(".trace > .trace-reads .trace-reads-count")?.textContent).toBe("1")
    const dispatch = container.querySelector(".trace-dispatch")!
    expect(dispatch.querySelector(".other-detail")?.textContent).toBe("Find the subscription")
    const nested = dispatch.querySelector(".trace-subagent")!
    expect(nested.querySelector(".trace-reads-count")?.textContent).toBe("2")
    expect(nested.querySelectorAll(".other-row")).toHaveLength(1)
    expect(container.querySelector(".trace-subagent-label")).toBeNull()
  })

  it("renders a child the host could not tie to a dispatch row as its own labelled group", () => {
    const { container } = render(
      <ToolTrace
        tools={[
          { update: update("c1", "read", { filePath: "src/foo.ts" }), actor: { kind: "subagent", sessionID: "ses_child", subagent: "explore" } },
        ]}
      />,
    )
    expect(container.querySelector(".trace-dispatch")).toBeNull()
    expect(container.querySelector(".trace-subagent-label")?.textContent).toBe("Explore agent")
    expect(container.querySelector(".trace-subagent .trace-reads-count")?.textContent).toBe("1")
  })
})
