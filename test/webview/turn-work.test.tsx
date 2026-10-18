import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { TurnAssistants, clusterProcessBlocks } from "../../webview/src/components/MessageView"
import type { Message, Block } from "../../webview/src/hooks/useChatState"

afterEach(cleanup)

function toolBlock(callID: string, tool: string, status = "completed", input: Record<string, unknown> = {}): Block {
  return {
    type: "tool",
    update: { callID, tool, status: status as any, input },
  }
}

function thoughtBlock(text: string): Block {
  return { type: "reasoning", text }
}

function textBlock(text: string): Block {
  return { type: "text", text }
}

describe("clusterProcessBlocks", () => {
  it("clusters consecutive reasoning blocks into Thought", () => {
    const blocks: Block[] = [thoughtBlock("Thinking 1"), thoughtBlock("Thinking 2")]
    const clusters = clusterProcessBlocks(blocks)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].kind).toBe("thought")
    expect(clusters[0].title).toBe("Thought")
    expect(clusters[0].blocks).toHaveLength(2)
  })

  it("clusters consecutive commands into 'Ran N commands'", () => {
    const blocks: Block[] = [
      toolBlock("c1", "bash", "completed", { command: "git status" }),
      toolBlock("c2", "sh", "completed", { command: "git diff" }),
      toolBlock("c3", "shell", "completed", { command: "bun test" }),
    ]
    const clusters = clusterProcessBlocks(blocks)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].kind).toBe("command")
    expect(clusters[0].title).toBe("Ran 3 commands")
  })

  it("clusters consecutive file reads into 'Explored N files'", () => {
    const blocks: Block[] = [
      toolBlock("r1", "read", "completed", { filePath: "src/a.ts" }),
      toolBlock("r2", "read", "completed", { filePath: "src/b.ts" }),
    ]
    const clusters = clusterProcessBlocks(blocks)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].kind).toBe("read")
    expect(clusters[0].title).toBe("Explored 2 files")
  })

  it("partitions mixed steps into sequential clusters matching reference hierarchy", () => {
    const blocks: Block[] = [
      thoughtBlock("Reviewing the instructions..."),
      toolBlock("c1", "bash", "completed", { command: "git branch -vv" }),
      toolBlock("c2", "bash", "completed", { command: "git log" }),
      toolBlock("r1", "read", "completed", { filePath: "package.json" }),
      toolBlock("c3", "bash", "completed", { command: "git status" }),
      toolBlock("t1", "task", "completed", { description: "investigate" }),
    ]
    const clusters = clusterProcessBlocks(blocks)
    expect(clusters).toHaveLength(5)
    expect(clusters[0].title).toBe("Thought")
    expect(clusters[1].title).toBe("Ran 2 commands")
    expect(clusters[2].title).toBe("Explored 1 file")
    expect(clusters[3].title).toBe("Ran 1 command")
    expect(clusters[4].title).toBe("Explored 1 task")
  })
})

describe("TurnAssistants master container", () => {
  it("groups 16 multi-step assistant messages under a single master Worked for collapse", () => {
    const assistants: Message[] = []
    for (let i = 0; i < 15; i++) {
      assistants.push({
        id: `a${i}`,
        role: "assistant",
        pending: false,
        blocks: [toolBlock(`call-${i}`, i % 2 === 0 ? "grep" : "read", "completed", { filePath: `f${i}.ts` })],
        time: { created: 1000 + i * 100, completed: 1000 + (i + 1) * 100 },
      } as Message)
    }
    // Final assistant message with tool and final answer
    assistants.push({
      id: "a15",
      role: "assistant",
      pending: false,
      blocks: [
        toolBlock("call-15", "bash", "completed", { command: "npm test" }),
        textBlock("Modificação implementada e validada."),
      ],
      time: { created: 2500, completed: 6000 },
    } as Message)

    const turn = {
      key: "turn-1",
      user: { id: "u1", role: "user", blocks: [textBlock("run tests")] } as Message,
      assistants,
    }

    const { container } = render(<TurnAssistants turn={turn} busy={false} />)

    // Master turn-work panel exists
    const master = container.querySelector(".turn-work")!
    expect(master).toBeInTheDocument()
    expect(master.classList.contains("is-open")).toBe(false)
    expect(screen.getByText(/Worked for/)).toBeInTheDocument()

    // The answer is directly visible below the collapsed work panel
    expect(screen.getByText("Modificação implementada e validada.")).toBeInTheDocument()

    // Clicking master expands the clusters inside
    const masterHead = master.querySelector<HTMLButtonElement>(".turn-work-head")!
    fireEvent.click(masterHead)
    expect(master.classList.contains("is-open")).toBe(true)

    // Inside the expanded body, sub-process steps are visible
    const subProcesses = master.querySelectorAll(".sub-process")
    expect(subProcesses.length).toBeGreaterThan(0)

    const firstSub = subProcesses[0] as HTMLElement
    const firstSubHead = firstSub.querySelector<HTMLButtonElement>(".process-head")!

    // By default for non-pending completed turn, sub-process is closed
    expect(firstSub.classList.contains("is-open")).toBe(false)

    // User can open it
    fireEvent.click(firstSubHead)
    expect(firstSub.classList.contains("is-open")).toBe(true)

    // User can close it
    fireEvent.click(firstSubHead)
    expect(firstSub.classList.contains("is-open")).toBe(false)
  })

  it("renders pure text replies directly with no turn-work panel", () => {
    const turn = {
      key: "turn-2",
      user: { id: "u2", role: "user", blocks: [textBlock("hi")] } as Message,
      assistants: [
        {
          id: "a-direct",
          role: "assistant",
          pending: false,
          blocks: [textBlock("Hello! How can I help?")],
        } as Message,
      ],
    }

    const { container } = render(<TurnAssistants turn={turn} busy={false} />)
    expect(container.querySelector(".turn-work")).toBeNull()
    expect(screen.getByText("Hello! How can I help?")).toBeInTheDocument()
  })
})
