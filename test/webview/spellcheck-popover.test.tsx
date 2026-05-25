import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PromptBox } from "../../webview/src/components/PromptBox"
import { __setCheckerForTests } from "../../webview/src/spellcheck/dictionary"

// Pretend dictionary: every word is correct except for a handful of typos we want to
// flag in tests. Suggestions are deterministic so we can assert against them.
const KNOWN_TYPOS: Record<string, string[]> = {
  helo: ["hello", "help", "halo"],
  frined: ["friend", "fined", "fringe"],
}

beforeEach(() => {
  __setCheckerForTests({
    correct: (w: string) => !(w in KNOWN_TYPOS),
    suggest: (w: string) => KNOWN_TYPOS[w] ?? [],
  })
})

afterEach(() => {
  cleanup()
  __setCheckerForTests(null)
})

describe("PromptBox spell-check", () => {
  it("underlines misspelled words in the backdrop after the debounce", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} />)
      await user.type(screen.getByRole("textbox"), "say helo there")
      vi.advanceTimersByTime(300)
      await waitFor(() => {
        const misses = document.querySelectorAll(".spellcheck-miss")
        expect(misses.length).toBe(1)
        expect(misses[0]!.textContent).toBe("helo")
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("shows suggestions on right-click and replaces the word when clicked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} />)
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
      await user.type(textarea, "say helo there")
      vi.advanceTimersByTime(300)
      await waitFor(() => {
        expect(document.querySelector(".spellcheck-miss")).not.toBeNull()
      })

      // Caret inside "helo" then right-click on the textarea.
      textarea.setSelectionRange(5, 5)
      fireEvent.contextMenu(textarea, { clientX: 100, clientY: 100 })

      // The popover lists our scripted suggestions.
      const popover = await screen.findByRole("menu", { name: /Spelling suggestions for helo/i })
      expect(popover).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "hello" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "help" })).toBeInTheDocument()

      // Click a suggestion → it replaces just the misspelled word, not the surrounding text.
      fireEvent.mouseDown(screen.getByRole("button", { name: "hello" }))
      expect(textarea.value).toBe("say hello there")
      expect(screen.queryByRole("menu", { name: /Spelling suggestions/i })).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not open the popover when right-click misses any misspelling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} />)
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
      await user.type(textarea, "say helo there")
      vi.advanceTimersByTime(300)
      await waitFor(() => {
        expect(document.querySelector(".spellcheck-miss")).not.toBeNull()
      })

      // Caret on the trailing "there" — not a typo — so contextmenu is a no-op.
      textarea.setSelectionRange(13, 13)
      fireEvent.contextMenu(textarea)
      expect(screen.queryByRole("menu", { name: /Spelling suggestions/i })).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("renders 'No suggestions' when the dictionary returns nothing", async () => {
    __setCheckerForTests({
      correct: (w: string) => w !== "frined",
      suggest: () => [],
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} />)
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
      await user.type(textarea, "my frined")
      vi.advanceTimersByTime(300)
      await waitFor(() => {
        expect(document.querySelector(".spellcheck-miss")).not.toBeNull()
      })
      textarea.setSelectionRange(5, 5)
      fireEvent.contextMenu(textarea)
      const popover = await screen.findByRole("menu", { name: /Spelling suggestions for frined/i })
      expect(popover.textContent).toMatch(/No suggestions/)
    } finally {
      vi.useRealTimers()
    }
  })

  it("ignores words inside @mention chips", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      // Even though "frined" is in our typo set, when it appears inside a known
      // @mention label it must not be flagged. We seed a mention via `initial`.
      render(
        <PromptBox
          busy={false}
          onSend={vi.fn()}
          onAbort={vi.fn()}
          initial={{ text: "look @frined.ts here", mentions: ["frined.ts"] }}
        />,
      )
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
      await user.click(textarea)
      vi.advanceTimersByTime(300)
      const misses = document.querySelectorAll(".spellcheck-miss")
      // "look" and "here" are real words; "@frined.ts" is a mention range and
      // path-like in any case — neither tokenization nor the detector touch it.
      expect(misses.length).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
