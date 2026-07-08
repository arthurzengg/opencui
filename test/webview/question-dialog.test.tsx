import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QuestionDialog } from "../../webview/src/components/QuestionDialog"
import type { QuestionInfo } from "../../webview/src/protocol"

afterEach(cleanup)

function q(overrides: Partial<QuestionInfo> = {}): QuestionInfo {
  return {
    question: "Which library?",
    header: "Library",
    options: [
      { label: "React", description: "the incumbent" },
      { label: "Solid", description: "" },
    ],
    ...overrides,
  }
}

describe("QuestionDialog", () => {
  it("renders header, question, options and descriptions", () => {
    render(<QuestionDialog id="q1" questions={[q()]} onReply={() => {}} onReject={() => {}} />)
    expect(screen.getByText(/Question from the assistant/)).toBeInTheDocument()
    expect(screen.getByText("Library")).toBeInTheDocument()
    expect(screen.getByText("Which library?")).toBeInTheDocument()
    expect(screen.getByText("React")).toBeInTheDocument()
    expect(screen.getByText("the incumbent")).toBeInTheDocument()
  })

  it("pluralizes the title for multiple questions", () => {
    render(
      <QuestionDialog
        id="q1"
        questions={[q(), q({ question: "Which style?", header: "Style" })]}
        onReply={() => {}}
        onReject={() => {}}
      />,
    )
    expect(screen.getByText(/Questions from the assistant/)).toBeInTheDocument()
  })

  it("disables Send until every question has an answer", async () => {
    const onReply = vi.fn()
    render(
      <QuestionDialog
        id="q1"
        questions={[q(), q({ question: "Which style?", header: "Style" })]}
        onReply={onReply}
        onReject={() => {}}
      />,
    )
    const send = screen.getByRole("button", { name: "Send" })
    expect(send).toBeDisabled()
    await userEvent.click(screen.getAllByRole("radio", { name: /React/ })[0]!)
    expect(send).toBeDisabled()
    await userEvent.click(screen.getAllByRole("radio", { name: /Solid/ })[1]!)
    expect(send).toBeEnabled()
    await userEvent.click(send)
    expect(onReply).toHaveBeenCalledWith("q1", [["React"], ["Solid"]])
  })

  it("single-select replaces the previous choice", async () => {
    const onReply = vi.fn()
    render(<QuestionDialog id="q1" questions={[q()]} onReply={onReply} onReject={() => {}} />)
    await userEvent.click(screen.getByRole("radio", { name: /React/ }))
    await userEvent.click(screen.getByRole("radio", { name: /Solid/ }))
    expect(screen.getByRole("radio", { name: /React/ })).toHaveAttribute("aria-checked", "false")
    expect(screen.getByRole("radio", { name: /Solid/ })).toHaveAttribute("aria-checked", "true")
    await userEvent.click(screen.getByRole("button", { name: "Send" }))
    expect(onReply).toHaveBeenCalledWith("q1", [["Solid"]])
  })

  it("multi-select toggles options independently", async () => {
    const onReply = vi.fn()
    render(<QuestionDialog id="q1" questions={[q({ multiple: true })]} onReply={onReply} onReject={() => {}} />)
    const react = screen.getByRole("checkbox", { name: /React/ })
    const solid = screen.getByRole("checkbox", { name: /Solid/ })
    await userEvent.click(react)
    await userEvent.click(solid)
    expect(react).toHaveAttribute("aria-checked", "true")
    expect(solid).toHaveAttribute("aria-checked", "true")
    await userEvent.click(react)
    expect(react).toHaveAttribute("aria-checked", "false")
    await userEvent.click(screen.getByRole("button", { name: "Send" }))
    expect(onReply).toHaveBeenCalledWith("q1", [["Solid"]])
  })

  it("appends a trimmed custom answer to the selected labels", async () => {
    const onReply = vi.fn()
    render(<QuestionDialog id="q1" questions={[q()]} onReply={onReply} onReject={() => {}} />)
    await userEvent.click(screen.getByRole("radio", { name: /React/ }))
    await userEvent.type(screen.getByPlaceholderText("Or type a custom answer…"), "  with hooks  ")
    await userEvent.click(screen.getByRole("button", { name: "Send" }))
    expect(onReply).toHaveBeenCalledWith("q1", [["React", "with hooks"]])
  })

  it("a custom answer alone enables Send", async () => {
    const onReply = vi.fn()
    render(<QuestionDialog id="q1" questions={[q()]} onReply={onReply} onReject={() => {}} />)
    const send = screen.getByRole("button", { name: "Send" })
    await userEvent.type(screen.getByPlaceholderText("Or type a custom answer…"), "neither")
    expect(send).toBeEnabled()
    await userEvent.click(send)
    expect(onReply).toHaveBeenCalledWith("q1", [["neither"]])
  })

  it("whitespace-only custom text does not enable Send", async () => {
    render(<QuestionDialog id="q1" questions={[q()]} onReply={() => {}} onReject={() => {}} />)
    await userEvent.type(screen.getByPlaceholderText("Or type a custom answer…"), "   ")
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
  })

  it("hides the custom textarea when custom is disabled", () => {
    render(<QuestionDialog id="q1" questions={[q({ custom: false })]} onReply={() => {}} onReject={() => {}} />)
    expect(document.querySelector(".question-custom")).toBeNull()
  })

  it("uses the answer-only placeholder when there are no options", () => {
    render(<QuestionDialog id="q1" questions={[q({ options: [] })]} onReply={() => {}} onReject={() => {}} />)
    expect(screen.getByPlaceholderText("Type your answer…")).toBeInTheDocument()
  })

  it("Skip rejects the request without answers", async () => {
    const onReject = vi.fn()
    render(<QuestionDialog id="q1" questions={[q()]} onReply={() => {}} onReject={onReject} />)
    await userEvent.click(screen.getByRole("button", { name: "Skip" }))
    expect(onReject).toHaveBeenCalledWith("q1")
  })

  it("resets selections when a different request is swapped in", async () => {
    const { rerender } = render(
      <QuestionDialog id="q1" questions={[q()]} onReply={() => {}} onReject={() => {}} />,
    )
    await userEvent.click(screen.getByRole("radio", { name: /React/ }))
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
    rerender(<QuestionDialog id="q2" questions={[q()]} onReply={() => {}} onReject={() => {}} />)
    expect(screen.getByRole("radio", { name: /React/ })).toHaveAttribute("aria-checked", "false")
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
  })
})
