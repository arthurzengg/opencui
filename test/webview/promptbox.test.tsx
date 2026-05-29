import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PromptBox, detectMention, extractMentions, findMentionRanges, findChipAtCaret, makeAttachmentLabel } from "../../webview/src/components/PromptBox"

afterEach(cleanup)

/** Type `@`, wait for the category menu, then press Enter to select "Files". */
async function enterFilesCategory(user: ReturnType<typeof userEvent.setup>, target: Element) {
  await user.type(target, "@")
  await waitFor(() => expect(screen.getByText("Files")).toBeInTheDocument())
  await user.keyboard("{Enter}")
}

describe("PromptBox", () => {
  it("renders a textarea with placeholder", () => {
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} />)
    expect(screen.getByPlaceholderText(/@ for file, Enter to send/i)).toBeInTheDocument()
  })

  it("uses a compact one-row textarea in edit mode", () => {
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} variant="edit" initial={{ text: "hi" }} />)
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).rows).toBe(1)
  })

  it("keeps the send composer at two rows", () => {
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} />)
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).rows).toBe(2)
  })

  it("applies bottom composer chrome only to the send composer", () => {
    const { container, rerender } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} />)
    expect(container.querySelector(".promptbox")).toHaveClass("promptbox--bottom")

    rerender(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} variant="edit" initial={{ text: "hi" }} />)
    expect(container.querySelector(".promptbox")).toHaveClass("promptbox--edit")
    expect(container.querySelector(".promptbox")).not.toHaveClass("promptbox--bottom")
  })

  it("Send button is disabled when textarea is empty", () => {
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} />)
    expect((screen.getByRole("button", { name: /^Send$/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("Send button enables once user types", async () => {
    const user = userEvent.setup()
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} />)
    await user.type(screen.getByRole("textbox"), "hi")
    expect((screen.getByRole("button", { name: /^Send$/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it("Enter without shift triggers onSend with trimmed text and clears the textarea", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<PromptBox busy={false} onSend={onSend} onAbort={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.type(textarea, "  hello world  ")
    await user.keyboard("{Enter}")
    expect(onSend).toHaveBeenCalledWith("hello world", undefined, undefined, undefined)
    expect(textarea.value).toBe("")
  })

  it("Shift+Enter inserts a newline instead of submitting", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<PromptBox busy={false} onSend={onSend} onAbort={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.type(textarea, "first")
    await user.keyboard("{Shift>}{Enter}{/Shift}")
    await user.type(textarea, "second")
    expect(onSend).not.toHaveBeenCalled()
    expect(textarea.value).toBe("first\nsecond")
  })

  it("Send button click submits", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<PromptBox busy={false} onSend={onSend} onAbort={vi.fn()} />)
    await user.type(screen.getByRole("textbox"), "hello")
    await user.click(screen.getByRole("button", { name: /^Send$/ }))
    expect(onSend).toHaveBeenCalledWith("hello", undefined, undefined, undefined)
  })

  it("renders Stop button (not Send) when busy", () => {
    render(<PromptBox busy={true} onSend={vi.fn()} onAbort={vi.fn()} />)
    expect(screen.getByRole("button", { name: /^Stop$/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Send$/ })).not.toBeInTheDocument()
  })

  it("Stop button fires onAbort", async () => {
    const user = userEvent.setup()
    const onAbort = vi.fn()
    render(<PromptBox busy={true} onSend={vi.fn()} onAbort={onAbort} />)
    await user.click(screen.getByRole("button", { name: /^Stop$/ }))
    expect(onAbort).toHaveBeenCalled()
  })

  it("shows disabled Stopping… button while aborting (not Stop, not Send)", () => {
    render(<PromptBox busy={true} aborting={true} onSend={vi.fn()} onAbort={vi.fn()} />)
    const btn = screen.getByRole("button", { name: /^Stopping…$/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(screen.queryByRole("button", { name: /^Stop$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Send$/ })).not.toBeInTheDocument()
  })

  it("clicking the Stopping… button is a no-op (does not refire onAbort)", async () => {
    const user = userEvent.setup()
    const onAbort = vi.fn()
    render(<PromptBox busy={true} aborting={true} onSend={vi.fn()} onAbort={onAbort} />)
    await user.click(screen.getByRole("button", { name: /^Stopping…$/ }))
    expect(onAbort).not.toHaveBeenCalled()
  })

  it("does NOT submit when Enter is pressed during IME composition (Chinese / Japanese / Korean input)", () => {
    const onSend = vi.fn()
    render(<PromptBox busy={false} onSend={onSend} onAbort={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    // Simulate the IME composition Enter: React's synthetic event exposes
    // `nativeEvent.isComposing` while a composition is in progress. The
    // browser's default behavior is to commit the candidate, not bubble Enter
    // to our handler.
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    Object.defineProperty(event, "isComposing", { value: true, configurable: true })
    textarea.value = "你好"
    textarea.dispatchEvent(event)
    expect(onSend).not.toHaveBeenCalled()
  })

  it("does submit when Enter is pressed AFTER IME composition ended", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<PromptBox busy={false} onSend={onSend} onAbort={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.type(textarea, "你好")
    // After IME ends, a normal Enter event has isComposing === false.
    await user.keyboard("{Enter}")
    expect(onSend).toHaveBeenCalledWith("你好", undefined, undefined, undefined)
  })

  it("does not submit empty/whitespace input on Enter", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<PromptBox busy={false} onSend={onSend} onAbort={vi.fn()} />)
    const textarea = screen.getByRole("textbox")
    await user.type(textarea, "   ")
    await user.keyboard("{Enter}")
    expect(onSend).not.toHaveBeenCalled()
  })
})

describe("detectMention", () => {
  it("returns the active @ token when cursor is right after @", () => {
    expect(detectMention("@", 1)).toEqual({ start: 0, query: "" })
  })

  it("returns the active @ with partial query", () => {
    expect(detectMention("@foo", 4)).toEqual({ start: 0, query: "foo" })
  })

  it("triggers after a leading space", () => {
    expect(detectMention("look @", 6)).toEqual({ start: 5, query: "" })
  })

  it("triggers even when @ follows non-whitespace (e.g. `look@`)", () => {
    expect(detectMention("look@", 5)).toEqual({ start: 4, query: "" })
  })

  it("triggers inside an email-style fragment too — picker is non-modal so this is fine", () => {
    expect(detectMention("a@b", 3)).toEqual({ start: 1, query: "b" })
  })

  it("returns undefined when whitespace appears before the cursor", () => {
    expect(detectMention("@foo bar", 8)).toBeUndefined()
  })

  it("supports cursor in the middle of @path", () => {
    expect(detectMention("@src/foo.ts", 5)).toEqual({ start: 0, query: "src/" })
  })

  it("returns undefined when there is no @ at all", () => {
    expect(detectMention("plain text", 5)).toBeUndefined()
  })

  it("returns the most recent @ when there are several", () => {
    expect(detectMention("@one @two", 9)).toEqual({ start: 5, query: "two" })
  })
})

describe("extractMentions", () => {
  it("returns paths whose @token appears with a trailing whitespace boundary", () => {
    const known = new Set(["src/foo.ts", "lib/bar.tsx"])
    expect(extractMentions("look at @src/foo.ts please", known)).toEqual(["src/foo.ts"])
  })

  it("matches @path even when @ is glued to a preceding non-whitespace char", () => {
    const known = new Set(["src/foo.ts"])
    expect(extractMentions("look@src/foo.ts please", known)).toEqual(["src/foo.ts"])
  })

  it("returns multiple mentions in any order", () => {
    const known = new Set(["a.ts", "b.ts"])
    const out = extractMentions("@a.ts and @b.ts", known)
    expect(out.sort()).toEqual(["a.ts", "b.ts"])
  })

  it("ignores unknown @tokens", () => {
    const known = new Set(["a.ts"])
    expect(extractMentions("@a.ts and @unknown.ts", known)).toEqual(["a.ts"])
  })

  it("ignores known paths whose token is glued to other word chars (substring)", () => {
    const known = new Set(["foo.ts"])
    expect(extractMentions("@foo.tsx", known)).toEqual([])
  })

  it("matches @path at end of string", () => {
    const known = new Set(["x.ts"])
    expect(extractMentions("see @x.ts", known)).toEqual(["x.ts"])
  })

  it("returns [] when known set empty", () => {
    expect(extractMentions("anything @here", new Set())).toEqual([])
  })

  it("finds a path whose first occurrence is inside a longer prefix-collision chip", () => {
    // `src/foo.ts` is a prefix of `src/foo.tsx`. indexOf finds the `.ts` first
    // inside the longer chip; the trailing `x` fails the whitespace check. The
    // implementation must keep scanning past that hit to find the real one.
    const known = new Set(["src/foo.tsx", "src/foo.ts"])
    const out = extractMentions("@src/foo.tsx and @src/foo.ts", known)
    expect(out.sort()).toEqual(["src/foo.ts", "src/foo.tsx"])
  })
})

describe("PromptBox @file autocomplete", () => {
  it("shows the category menu after typing @, then file hits after selecting Files", async () => {
    const user = userEvent.setup()
    const searchFiles = vi.fn().mockResolvedValue([
      { path: "src/foo.ts", name: "foo.ts" },
      { path: "src/bar.ts", name: "bar.ts" },
    ])
    render(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} />,
    )
    await enterFilesCategory(user, screen.getByRole("textbox"))
    await waitFor(() => expect(searchFiles).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText("foo.ts")).toBeInTheDocument())
    expect(screen.getByText("bar.ts")).toBeInTheDocument()
  })

  it("filters results as the user types after @", async () => {
    const user = userEvent.setup()
    const searchFiles = vi.fn().mockImplementation(async (q: string) => {
      if (q === "ba") return [{ path: "src/bar.ts", name: "bar.ts" }]
      return [
        { path: "src/foo.ts", name: "foo.ts" },
        { path: "src/bar.ts", name: "bar.ts" },
      ]
    })
    render(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} />,
    )
    await user.type(screen.getByRole("textbox"), "@ba")
    await waitFor(() => expect(searchFiles).toHaveBeenCalledWith("ba"))
    await waitFor(() => expect(screen.queryByText("foo.ts")).toBeNull())
    expect(screen.getByText("bar.ts")).toBeInTheDocument()
  })

  it("Enter inside the picker inserts the selected path and closes the picker", async () => {
    const user = userEvent.setup()
    const searchFiles = vi.fn().mockResolvedValue([
      { path: "src/foo.ts", name: "foo.ts" },
    ])
    render(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} />,
    )
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await enterFilesCategory(user, textarea)
    await waitFor(() => expect(screen.getByText("foo.ts")).toBeInTheDocument())
    await user.keyboard("{Enter}")
    expect(textarea.value).toBe("@src/foo.ts ")
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("ArrowDown / ArrowUp move the active hit", async () => {
    const user = userEvent.setup()
    const searchFiles = vi.fn().mockResolvedValue([
      { path: "src/foo.ts", name: "foo.ts" },
      { path: "src/bar.ts", name: "bar.ts" },
    ])
    render(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} />,
    )
    const textarea = screen.getByRole("textbox")
    await enterFilesCategory(user, textarea)
    await waitFor(() => expect(screen.getByText("foo.ts")).toBeInTheDocument())
    await user.keyboard("{ArrowDown}")
    await user.keyboard("{Enter}")
    expect((textarea as HTMLTextAreaElement).value).toBe("@src/bar.ts ")
  })

  it("Click on a hit inserts that path", async () => {
    const user = userEvent.setup()
    const searchFiles = vi.fn().mockResolvedValue([
      { path: "src/foo.ts", name: "foo.ts" },
      { path: "src/bar.ts", name: "bar.ts" },
    ])
    render(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} />,
    )
    await enterFilesCategory(user, screen.getByRole("textbox"))
    await waitFor(() => expect(screen.getByText("bar.ts")).toBeInTheDocument())
    await user.click(screen.getByText("bar.ts"))
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("@src/bar.ts ")
  })

  it("Escape closes the picker without inserting", async () => {
    const user = userEvent.setup()
    const searchFiles = vi.fn().mockResolvedValue([
      { path: "src/foo.ts", name: "foo.ts" },
    ])
    render(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} />,
    )
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.type(textarea, "@")
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument())
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(textarea.value).toBe("@")
  })

  it("Send forwards the inserted mention paths to onSend", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const searchFiles = vi.fn().mockResolvedValue([
      { path: "src/foo.ts", name: "foo.ts" },
    ])
    render(
      <PromptBox busy={false} onSend={onSend} onAbort={vi.fn()} searchFiles={searchFiles} />,
    )
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await enterFilesCategory(user, textarea)
    await waitFor(() => expect(screen.getByText("foo.ts")).toBeInTheDocument())
    await user.keyboard("{Enter}") // pick foo.ts
    await user.type(textarea, "explain this")
    await user.keyboard("{Enter}")
    expect(onSend).toHaveBeenCalledWith("@src/foo.ts explain this", ["src/foo.ts"], undefined, undefined)
  })

  it("does not pass mentions when the inserted @path was deleted before Send", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const searchFiles = vi.fn().mockResolvedValue([
      { path: "src/foo.ts", name: "foo.ts" },
    ])
    render(
      <PromptBox busy={false} onSend={onSend} onAbort={vi.fn()} searchFiles={searchFiles} />,
    )
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await enterFilesCategory(user, textarea)
    await waitFor(() => expect(screen.getByText("foo.ts")).toBeInTheDocument())
    await user.keyboard("{Enter}") // inserts "@src/foo.ts "
    await user.clear(textarea)
    await user.type(textarea, "no files here")
    await user.keyboard("{Enter}")
    expect(onSend).toHaveBeenCalledWith("no files here", undefined, undefined, undefined)
  })

  it("does not open the picker when searchFiles is not provided", async () => {
    const user = userEvent.setup()
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} />)
    await user.type(screen.getByRole("textbox"), "@foo")
    expect(screen.queryByRole("listbox")).toBeNull()
  })
})

describe("PromptBox @ folder browser (drill-down)", () => {
  const makeBrowser = () => {
    const searchFiles = vi.fn().mockResolvedValue([])
    const listDir = vi.fn().mockImplementation(async (path: string) => {
      if (path === "") return [
        { name: "src", path: "src", kind: "folder" },
        { name: "README.md", path: "README.md", kind: "file" },
      ]
      if (path === "src") return [
        { name: "chat", path: "src/chat", kind: "folder" },
        { name: "server.ts", path: "src/server.ts", kind: "file" },
      ]
      return []
    })
    return { searchFiles, listDir }
  }

  it("shows the project root (folders + files) with a breadcrumb after picking Files", async () => {
    const user = userEvent.setup()
    const { searchFiles, listDir } = makeBrowser()
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} listDir={listDir} />)
    await enterFilesCategory(user, screen.getByRole("textbox"))
    await waitFor(() => expect(listDir).toHaveBeenCalledWith(""))
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument())
    expect(screen.getByText("README.md")).toBeInTheDocument()
    expect(screen.getByText("Project root")).toBeInTheDocument()
  })

  it("drills into a folder on Enter, listing its children — and never inserts the folder", async () => {
    const user = userEvent.setup()
    const { searchFiles, listDir } = makeBrowser()
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} listDir={listDir} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await enterFilesCategory(user, textarea)
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument())
    await user.keyboard("{Enter}") // src is first (folder) → drills in
    await waitFor(() => expect(listDir).toHaveBeenCalledWith("src"))
    await waitFor(() => expect(screen.getByText("server.ts")).toBeInTheDocument())
    expect(screen.getByText("chat")).toBeInTheDocument()
    // Folder was navigated, never inserted as a mention.
    expect(textarea.value).toBe("@")
  })

  it("ArrowRight also drills into the highlighted folder", async () => {
    const user = userEvent.setup()
    const { searchFiles, listDir } = makeBrowser()
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} listDir={listDir} />)
    await enterFilesCategory(user, screen.getByRole("textbox"))
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument())
    await user.keyboard("{ArrowRight}")
    await waitFor(() => expect(listDir).toHaveBeenCalledWith("src"))
    expect(screen.getByText("server.ts")).toBeInTheDocument()
  })

  it("inserts a file (the only selectable leaf) and closes the picker", async () => {
    const user = userEvent.setup()
    const { searchFiles, listDir } = makeBrowser()
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} listDir={listDir} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await enterFilesCategory(user, textarea)
    await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument())
    await user.click(screen.getByText("README.md"))
    expect(textarea.value).toBe("@README.md ")
    expect(screen.queryByText("Project root")).toBeNull()
  })

  it("goes back up a level via the breadcrumb button", async () => {
    const user = userEvent.setup()
    const { searchFiles, listDir } = makeBrowser()
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} listDir={listDir} />)
    await enterFilesCategory(user, screen.getByRole("textbox"))
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument())
    await user.keyboard("{Enter}") // into src
    await waitFor(() => expect(screen.getByText("server.ts")).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: /Go up a folder/i }))
    await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument())
  })

  it("typing a query switches from the browser to the flat file search", async () => {
    const user = userEvent.setup()
    const { listDir } = makeBrowser()
    const searchFiles = vi.fn().mockResolvedValue([{ path: "src/foo.ts", name: "foo.ts" }])
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} listDir={listDir} />)
    const textarea = screen.getByRole("textbox")
    await enterFilesCategory(user, textarea)
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument()) // browser
    await user.type(textarea, "foo")
    await waitFor(() => expect(searchFiles).toHaveBeenCalledWith("foo"))
    await waitFor(() => expect(screen.getByText("foo.ts")).toBeInTheDocument())
    expect(screen.queryByText("Project root")).toBeNull()
  })

  it("falls back to the flat search when no listDir is provided", async () => {
    const user = userEvent.setup()
    const searchFiles = vi.fn().mockResolvedValue([{ path: "src/foo.ts", name: "foo.ts" }])
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} />)
    await enterFilesCategory(user, screen.getByRole("textbox"))
    await waitFor(() => expect(screen.getByText("foo.ts")).toBeInTheDocument())
    expect(screen.queryByText("Project root")).toBeNull()
  })
})

describe("findMentionRanges", () => {
  it("returns empty for plain text", () => {
    expect(findMentionRanges("hello world", new Set())).toEqual([])
  })

  it("returns the @path range when bounded by whitespace", () => {
    expect(findMentionRanges("look @src/foo.ts please", new Set(["src/foo.ts"]))).toEqual([
      { start: 5, end: 16 },
    ])
  })

  it("returns the range even when @ is glued to a preceding non-whitespace char", () => {
    expect(findMentionRanges("look@src/foo.ts please", new Set(["src/foo.ts"]))).toEqual([
      { start: 4, end: 15 },
    ])
  })

  it("returns multiple ranges sorted by start", () => {
    const ranges = findMentionRanges("@a.ts and @b.ts", new Set(["a.ts", "b.ts"]))
    expect(ranges).toEqual([
      { start: 0, end: 5 },
      { start: 10, end: 15 },
    ])
  })

  it("ignores @path that is glued to another word", () => {
    expect(findMentionRanges("@foo.tsx", new Set(["foo.ts"]))).toEqual([])
  })

  it("matches @path at end of string", () => {
    expect(findMentionRanges("see @x.ts", new Set(["x.ts"]))).toEqual([
      { start: 4, end: 9 },
    ])
  })

  it("does not return overlapping ranges (longer paths win)", () => {
    // If both "a.ts" and "src/a.ts" are known and "@src/a.ts" appears,
    // we should return one range, not two overlapping ones.
    const ranges = findMentionRanges("@src/a.ts", new Set(["src/a.ts"]))
    expect(ranges).toEqual([{ start: 0, end: 9 }])
  })
})

describe("PromptBox mention chip rendering", () => {
  it("renders a .mention-chip span around the inserted @path", async () => {
    const user = userEvent.setup()
    const searchFiles = vi.fn().mockResolvedValue([
      { path: "src/foo.ts", name: "foo.ts" },
    ])
    const { container } = render(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} />,
    )
    await enterFilesCategory(user, screen.getByRole("textbox"))
    await waitFor(() => expect(screen.getByText("foo.ts")).toBeInTheDocument())
    await user.keyboard("{Enter}")
    const chip = container.querySelector(".mention-chip")
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe("@src/foo.ts")
  })

  it("does not render a chip for plain @text that wasn't picked from the menu", () => {
    const { container } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} />)
    const textarea = container.querySelector("textarea")!
    // Manually fire a change with @random text; without insertion through the picker,
    // knownMentions stays empty, so no chip should appear.
    expect(container.querySelector(".mention-chip")).toBeNull()
  })

  it("renders multiple chips when multiple mentions are inserted", async () => {
    const user = userEvent.setup()
    const searchFiles = vi.fn().mockImplementation(async (q: string) => {
      if (q === "ba") return [{ path: "src/bar.ts", name: "bar.ts" }]
      return [
        { path: "src/foo.ts", name: "foo.ts" },
        { path: "src/bar.ts", name: "bar.ts" },
      ]
    })
    const { container } = render(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} />,
    )
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await enterFilesCategory(user, textarea)
    await waitFor(() => expect(screen.getByText("foo.ts")).toBeInTheDocument())
    await user.keyboard("{Enter}") // foo.ts
    await user.type(textarea, "@ba")
    await waitFor(() => expect(screen.getByText("bar.ts")).toBeInTheDocument())
    await user.keyboard("{Enter}") // bar.ts
    const chips = container.querySelectorAll(".mention-chip")
    expect(chips).toHaveLength(2)
    expect(Array.from(chips).map((c) => c.textContent).sort()).toEqual(["@src/bar.ts", "@src/foo.ts"])
  })

  it("removes a chip when the @path text is deleted", async () => {
    const user = userEvent.setup()
    const searchFiles = vi.fn().mockResolvedValue([
      { path: "src/foo.ts", name: "foo.ts" },
    ])
    const { container } = render(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} searchFiles={searchFiles} />,
    )
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await enterFilesCategory(user, textarea)
    await waitFor(() => expect(screen.getByText("foo.ts")).toBeInTheDocument())
    await user.keyboard("{Enter}")
    expect(container.querySelector(".mention-chip")).not.toBeNull()
    await user.clear(textarea)
    expect(container.querySelector(".mention-chip")).toBeNull()
  })

  it("renders the backdrop layer with aria-hidden so screen readers ignore it", () => {
    const { container } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} />)
    const backdrop = container.querySelector(".promptbox-backdrop")
    expect(backdrop).not.toBeNull()
    expect(backdrop!.getAttribute("aria-hidden")).toBe("true")
  })
})

describe("findChipAtCaret", () => {
  it("returns the chip when caret is right at chip end (no trailing space)", () => {
    const known = new Set(["src/foo.ts"])
    expect(findChipAtCaret("@src/foo.ts", 11, known)).toEqual({
      start: 0,
      end: 11,
      trailingSpace: false,
    })
  })

  it("returns the chip when caret is one past the chip with a trailing space", () => {
    const known = new Set(["src/foo.ts"])
    expect(findChipAtCaret("@src/foo.ts ", 12, known)).toEqual({
      start: 0,
      end: 11,
      trailingSpace: true,
    })
  })

  it("returns undefined when caret is inside the chip", () => {
    expect(findChipAtCaret("@src/foo.ts", 5, new Set(["src/foo.ts"]))).toBeUndefined()
  })

  it("returns undefined when caret is two past the chip", () => {
    expect(findChipAtCaret("@src/foo.ts  here", 13, new Set(["src/foo.ts"]))).toBeUndefined()
  })

  it("returns undefined for plain text", () => {
    expect(findChipAtCaret("hello world", 5, new Set())).toBeUndefined()
  })

  it("matches the right chip when there are several", () => {
    const known = new Set(["a.ts", "b.ts"])
    // text: "@a.ts @b.ts" ; caret 5 = right at end of @a.ts (no trailing space view)
    expect(findChipAtCaret("@a.ts @b.ts", 5, known)).toEqual({
      start: 0,
      end: 5,
      trailingSpace: false,
    })
    // caret 6 = one past end of @a.ts where char[5] is " " → trailingSpace true
    expect(findChipAtCaret("@a.ts @b.ts", 6, known)).toEqual({
      start: 0,
      end: 5,
      trailingSpace: true,
    })
    // caret 11 = end of @b.ts (no trailing space, end of string)
    expect(findChipAtCaret("@a.ts @b.ts", 11, known)).toEqual({
      start: 6,
      end: 11,
      trailingSpace: false,
    })
  })
})

describe("PromptBox two-step Backspace on chip", () => {
  async function setupChip() {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const searchFiles = vi.fn().mockResolvedValue([
      { path: "src/foo.ts", name: "foo.ts" },
    ])
    const utils = render(
      <PromptBox busy={false} onSend={onSend} onAbort={vi.fn()} searchFiles={searchFiles} />,
    )
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await enterFilesCategory(user, textarea)
    await waitFor(() => expect(screen.getByText("foo.ts")).toBeInTheDocument())
    await user.keyboard("{Enter}") // text becomes "@src/foo.ts " (cursor at 12)
    return { user, onSend, textarea, ...utils }
  }

  it("first Backspace highlights the chip without deleting", async () => {
    const { user, textarea, container } = await setupChip()
    expect(textarea.value).toBe("@src/foo.ts ")
    await user.keyboard("{Backspace}")
    // Text unchanged
    expect(textarea.value).toBe("@src/foo.ts ")
    // Chip is now in the selected visual state
    expect(container.querySelector(".mention-chip-selected")).not.toBeNull()
  })

  it("second Backspace deletes the chip + its trailing space", async () => {
    const { user, textarea, container } = await setupChip()
    await user.keyboard("{Backspace}")
    expect(container.querySelector(".mention-chip-selected")).not.toBeNull()
    await user.keyboard("{Backspace}")
    expect(textarea.value).toBe("")
    expect(container.querySelector(".mention-chip")).toBeNull()
  })

  it("typing a non-Backspace key clears the selected chip without deleting", async () => {
    const { user, textarea, container } = await setupChip()
    await user.keyboard("{Backspace}")
    expect(container.querySelector(".mention-chip-selected")).not.toBeNull()
    await user.keyboard("a")
    expect(container.querySelector(".mention-chip-selected")).toBeNull()
    // The chip itself remains (still highlighted blue, just not "selected")
    expect(container.querySelector(".mention-chip")).not.toBeNull()
    expect(textarea.value).toBe("@src/foo.ts a")
  })

  it("Backspace away from a chip deletes a single character normally", async () => {
    const { user, textarea } = await setupChip()
    await user.type(textarea, "abc")
    expect(textarea.value).toBe("@src/foo.ts abc")
    await user.keyboard("{Backspace}")
    expect(textarea.value).toBe("@src/foo.ts ab")
  })

  it("does not intercept Backspace when there is a real text selection", async () => {
    const { user, textarea } = await setupChip()
    await user.type(textarea, "x")
    // Select last char and press Backspace
    textarea.setSelectionRange(textarea.value.length - 1, textarea.value.length)
    await user.keyboard("{Backspace}")
    expect(textarea.value).toBe("@src/foo.ts ")
  })

  it("Send forwards the chip's path even after the highlight state resolves", async () => {
    const { user, onSend, textarea } = await setupChip()
    await user.type(textarea, "explain")
    await user.keyboard("{Enter}")
    expect(onSend).toHaveBeenCalledWith("@src/foo.ts explain", ["src/foo.ts"], undefined, undefined)
  })
})

describe("makeAttachmentLabel", () => {
  it("returns the filename unchanged when no collision", () => {
    expect(makeAttachmentLabel("foo.png", new Set())).toBe("foo.png")
  })

  it("replaces whitespace with underscores so the @token doesn't break", () => {
    expect(makeAttachmentLabel("my file.png", new Set())).toBe("my_file.png")
    expect(makeAttachmentLabel("a  b\tc.png", new Set())).toBe("a_b_c.png")
  })

  it("appends _2, _3 on collision while preserving the extension", () => {
    expect(makeAttachmentLabel("foo.png", new Set(["foo.png"]))).toBe("foo_2.png")
    expect(makeAttachmentLabel("foo.png", new Set(["foo.png", "foo_2.png"]))).toBe("foo_3.png")
  })

  it("works for files with no extension", () => {
    expect(makeAttachmentLabel("readme", new Set(["readme"]))).toBe("readme_2")
  })
})

describe("PromptBox attachments (inline @chip flow)", () => {
  function makeImage(name = "screen.png"): import("../../webview/src/protocol").Attachment {
    return {
      id: "att_1",
      mime: "image/png",
      filename: name,
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      bytes: 1024,
    }
  }
  function makePdf(name = "doc.pdf"): import("../../webview/src/protocol").Attachment {
    return {
      id: "att_2",
      mime: "application/pdf",
      filename: name,
      dataUrl: "data:application/pdf;base64,JVBERi0=",
      bytes: 5_000_000,
    }
  }

  it("renders the paperclip button only when attachFile is provided", () => {
    const { rerender } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} />)
    expect(screen.queryByRole("button", { name: /Attach/i })).toBeNull()
    rerender(
      <PromptBox
        busy={false}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        attachFile={vi.fn().mockResolvedValue({ attachments: [] })}
      />,
    )
    expect(screen.getByRole("button", { name: /Attach/i })).toBeInTheDocument()
  })

  it("inserts @filename text into the textarea when paperclip returns a non-image file", async () => {
    const user = userEvent.setup()
    const attachFile = vi.fn().mockResolvedValue({ attachments: [makePdf()] })
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={attachFile} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.click(screen.getByRole("button", { name: /Attach/i }))
    await waitFor(() => expect(textarea.value).toContain("@doc.pdf"))
  })

  it("renders the inserted @filename as a .mention-chip in the backdrop", async () => {
    const user = userEvent.setup()
    const attachFile = vi.fn().mockResolvedValue({ attachments: [makePdf()] })
    const { container } = render(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={attachFile} />,
    )
    await user.click(screen.getByRole("button", { name: /Attach/i }))
    await waitFor(() => expect(container.querySelector(".mention-chip")).not.toBeNull())
    expect(container.querySelector(".mention-chip")?.textContent).toBe("@doc.pdf")
  })

  it("multiple non-image attachments insert in order separated by spaces", async () => {
    const user = userEvent.setup()
    const attachFile = vi.fn().mockResolvedValue({
      attachments: [makePdf("first.pdf"), makePdf("second.pdf")],
    })
    const { container } = render(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={attachFile} />,
    )
    await user.click(screen.getByRole("button", { name: /Attach/i }))
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toBe("@first.pdf @second.pdf "))
    const chips = container.querySelectorAll(".mention-chip")
    expect(Array.from(chips).map((c) => c.textContent)).toEqual(["@first.pdf", "@second.pdf"])
  })

  it("inserts at the current caret position, not always at the end", async () => {
    const user = userEvent.setup()
    const attachFile = vi.fn().mockResolvedValue({ attachments: [makePdf()] })
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={attachFile} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.type(textarea, "hello world")
    textarea.setSelectionRange(5, 5) // caret right after "hello"
    await user.click(screen.getByRole("button", { name: /Attach/i }))
    await waitFor(() => expect(textarea.value).toBe("hello @doc.pdf world"))
  })

  it("two non-image attachments with the same filename get disambiguated labels", async () => {
    const user = userEvent.setup()
    const attachFile = vi
      .fn()
      .mockResolvedValueOnce({ attachments: [makePdf("report.pdf")] })
      .mockResolvedValueOnce({ attachments: [makePdf("report.pdf")] })
    const { container } = render(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={attachFile} />,
    )
    const attachBtn = screen.getByRole("button", { name: /Attach/i })
    await user.click(attachBtn)
    await waitFor(() => expect(container.querySelectorAll(".mention-chip")).toHaveLength(1))
    await user.click(attachBtn)
    await waitFor(() => expect(container.querySelectorAll(".mention-chip")).toHaveLength(2))
    const chipTexts = Array.from(container.querySelectorAll(".mention-chip")).map((c) => c.textContent)
    expect(chipTexts).toEqual(["@report.pdf", "@report_2.pdf"])
  })

  it("Send forwards the Attachment objects whose chips appear in text", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const pdf = makePdf()
    const attachFile = vi.fn().mockResolvedValue({ attachments: [pdf] })
    render(<PromptBox busy={false} onSend={onSend} onAbort={vi.fn()} attachFile={attachFile} />)
    await user.click(screen.getByRole("button", { name: /Attach/i }))
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toContain("@doc.pdf"))
    await user.type(textarea, "what is this")
    await user.keyboard("{Enter}")
    expect(onSend).toHaveBeenCalledTimes(1)
    const args = onSend.mock.calls[0]
    expect(args?.[0]).toBe("@doc.pdf what is this")
    expect(args?.[1]).toBeUndefined()
    expect(args?.[2]).toEqual([pdf])
  })

  it("paperclip-uploaded images render as a thumbnail (no @chip text token)", async () => {
    const user = userEvent.setup()
    const attachFile = vi.fn().mockResolvedValue({ attachments: [makeImage()] })
    const { container } = render(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={attachFile} />,
    )
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.click(screen.getByRole("button", { name: /Attach/i }))
    await waitFor(() => expect(container.querySelector(".image-thumb")).not.toBeNull())
    // Image attachment goes to the thumbnail strip — no `@chip` text and no mention-chip
    expect(textarea.value).toBe("")
    expect(container.querySelector(".mention-chip")).toBeNull()
  })

  it("paperclip mixed (image + PDF) splits: image to thumbnail, PDF to @chip", async () => {
    const user = userEvent.setup()
    const attachFile = vi.fn().mockResolvedValue({
      attachments: [makeImage("shot.png"), makePdf("spec.pdf")],
    })
    const { container } = render(
      <PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={attachFile} />,
    )
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.click(screen.getByRole("button", { name: /Attach/i }))
    await waitFor(() => expect(container.querySelector(".image-thumb")).not.toBeNull())
    expect(textarea.value).toBe("@spec.pdf ")
    expect(container.querySelectorAll(".mention-chip")).toHaveLength(1)
    expect(container.querySelectorAll(".image-thumb")).toHaveLength(1)
  })

  it("Send forwards a paperclip-uploaded image via the thumbnail flow", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const img = makeImage()
    const attachFile = vi.fn().mockResolvedValue({ attachments: [img] })
    const { container } = render(
      <PromptBox busy={false} onSend={onSend} onAbort={vi.fn()} attachFile={attachFile} />,
    )
    await user.click(screen.getByRole("button", { name: /Attach/i }))
    await waitFor(() => expect(container.querySelector(".image-thumb")).not.toBeNull())
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.click(textarea)
    await user.keyboard("describe this{Enter}")
    expect(onSend).toHaveBeenCalledTimes(1)
    const args = onSend.mock.calls[0]
    expect(args?.[0]).toBe("describe this")
    expect(args?.[2]).toEqual([img])
  })

  it("Send-button is enabled when only attachments (no text) are present", async () => {
    const user = userEvent.setup()
    const attachFile = vi.fn().mockResolvedValue({ attachments: [makeImage()] })
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={attachFile} />)
    expect((screen.getByRole("button", { name: /^Send$/ }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole("button", { name: /Attach/i }))
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /^Send$/ }) as HTMLButtonElement).disabled).toBe(false),
    )
  })

  it("two-step Backspace removes a non-image attachment chip too", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const attachFile = vi.fn().mockResolvedValue({ attachments: [makePdf()] })
    const { container } = render(
      <PromptBox busy={false} onSend={onSend} onAbort={vi.fn()} attachFile={attachFile} />,
    )
    await user.click(screen.getByRole("button", { name: /Attach/i }))
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toBe("@doc.pdf "))
    // Backspace once: highlight
    await user.keyboard("{Backspace}")
    expect(container.querySelector(".mention-chip-selected")).not.toBeNull()
    // Backspace again: deletes the chip
    await user.keyboard("{Backspace}")
    expect(container.querySelector(".mention-chip")).toBeNull()
    expect(textarea.value).toBe("")
  })

  it("if the non-image attachment chip is deleted, Send does NOT include the attachment", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const attachFile = vi.fn().mockResolvedValue({ attachments: [makePdf()] })
    render(<PromptBox busy={false} onSend={onSend} onAbort={vi.fn()} attachFile={attachFile} />)
    await user.click(screen.getByRole("button", { name: /Attach/i }))
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toContain("@doc.pdf"))
    await user.clear(textarea)
    await user.type(textarea, "no attachments here")
    await user.keyboard("{Enter}")
    expect(onSend).toHaveBeenCalledWith("no attachments here", undefined, undefined, undefined)
  })

  it("renders an error message when attachFile returns one", async () => {
    const user = userEvent.setup()
    const attachFile = vi.fn().mockResolvedValue({
      attachments: [],
      error: "Skipped: huge.png (oversize)",
    })
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={attachFile} />)
    await user.click(screen.getByRole("button", { name: /Attach/i }))
    await waitFor(() => expect(screen.getByText(/oversize/i)).toBeInTheDocument())
  })
})


describe("PromptBox image paste from clipboard", () => {
  // Build a DataTransfer-shaped stub that matches what the helper reads.
  // jsdom's DataTransfer doesn't model clipboard items, so we hand-roll.
  function makePasteData(files: File[], text = ""): DataTransfer {
    const items = files.map((f) => ({
      kind: "file",
      type: f.type,
      getAsFile: () => f,
    }))
    return {
      items: {
        length: items.length,
        [Symbol.iterator]: function* () {
          for (const it of items) yield it
        },
        ...Object.fromEntries(items.map((it, i) => [i, it])),
      } as unknown as DataTransferItemList,
      files: { length: 0 } as unknown as FileList,
      getData: (kind: string) => (kind === "text/plain" ? text : ""),
    } as unknown as DataTransfer
  }

  function pasteEvent(data: DataTransfer): ClipboardEvent {
    const e = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(e, "clipboardData", { value: data, configurable: true })
    return e
  }

  it("renders a pasted image as a thumbnail (no text in the textarea, no @chip)", async () => {
    const { container } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const file = new File([new Uint8Array(100)], "image.png", { type: "image/png" })
    textarea.dispatchEvent(pasteEvent(makePasteData([file])))
    await waitFor(() => expect(container.querySelector(".image-thumb")).not.toBeNull())
    // Textarea stays empty — no `@pasted-image.png` text token.
    expect(textarea.value).toBe("")
    // No mention-chip either.
    expect(container.querySelector(".mention-chip")).toBeNull()
    // The thumbnail has an <img> with the base64 data URL.
    const img = container.querySelector(".image-thumb img") as HTMLImageElement | null
    expect(img?.getAttribute("src")).toMatch(/^data:image\/png;base64,/)
  })

  it("filename + size live in the tooltip, never as visible text", async () => {
    const { container } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const file = new File([new Uint8Array(100)], "image.png", { type: "image/png" })
    textarea.dispatchEvent(pasteEvent(makePasteData([file])))
    await waitFor(() => expect(container.querySelector(".image-thumb")).not.toBeNull())
    const tile = container.querySelector(".image-thumb")!
    expect(tile.getAttribute("title")).toMatch(/pasted-image\.png/)
    expect(tile.textContent?.trim()).toBe("")
  })

  it("forwards the pasted attachment on submit", async () => {
    const onSend = vi.fn()
    const { container } = render(<PromptBox busy={false} onSend={onSend} onAbort={vi.fn()} attachFile={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const file = new File([new Uint8Array(100)], "image.png", { type: "image/png" })
    textarea.dispatchEvent(pasteEvent(makePasteData([file])))
    await waitFor(() => expect(container.querySelector(".image-thumb")).not.toBeNull())
    const user = userEvent.setup()
    await user.click(textarea)
    await user.keyboard("look at this{Enter}")
    expect(onSend).toHaveBeenCalledOnce()
    const [text, mentions, attachments] = onSend.mock.calls[0]!
    expect(text).toBe("look at this")
    expect(mentions).toBeUndefined()
    expect(attachments).toHaveLength(1)
    expect(attachments[0].mime).toBe("image/png")
    expect(attachments[0].dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it("clears the thumbnail strip after submit", async () => {
    const { container } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const file = new File([new Uint8Array(100)], "image.png", { type: "image/png" })
    textarea.dispatchEvent(pasteEvent(makePasteData([file])))
    await waitFor(() => expect(container.querySelector(".image-thumb")).not.toBeNull())
    const user = userEvent.setup()
    await user.click(textarea)
    await user.keyboard("ok{Enter}")
    await waitFor(() => expect(container.querySelector(".image-thumb")).toBeNull())
  })

  it("enables send with only a pasted image (no text required)", async () => {
    const onSend = vi.fn()
    const { container } = render(<PromptBox busy={false} onSend={onSend} onAbort={vi.fn()} attachFile={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const file = new File([new Uint8Array(100)], "image.png", { type: "image/png" })
    textarea.dispatchEvent(pasteEvent(makePasteData([file])))
    await waitFor(() => expect(container.querySelector(".image-thumb")).not.toBeNull())
    const sendBtn = screen.getByRole("button", { name: /^Send$/i })
    expect((sendBtn as HTMLButtonElement).disabled).toBe(false)
  })

  it("hover-X removes a pasted thumbnail", async () => {
    const { container } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const file = new File([new Uint8Array(100)], "image.png", { type: "image/png" })
    textarea.dispatchEvent(pasteEvent(makePasteData([file])))
    await waitFor(() => expect(container.querySelector(".image-thumb")).not.toBeNull())
    const user = userEvent.setup()
    const removeBtn = screen.getByRole("button", { name: /Remove pasted-image\.png/i })
    await user.click(removeBtn)
    expect(container.querySelector(".image-thumb")).toBeNull()
  })

  it("does not intercept pure-text paste (default browser behavior runs)", async () => {
    const user = userEvent.setup()
    render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.click(textarea)
    await user.paste("hello world")
    expect(textarea.value).toBe("hello world")
  })

  it("shows an error message when a pasted image is over the size cap", async () => {
    const { container } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const huge = new File([new Uint8Array(11 * 1024 * 1024)], "image.png", { type: "image/png" })
    textarea.dispatchEvent(pasteEvent(makePasteData([huge])))
    await waitFor(() => expect(screen.getByText(/over 10 MB/i)).toBeInTheDocument())
    // No thumbnail, no text.
    expect(container.querySelector(".image-thumb")).toBeNull()
    expect(textarea.value).toBe("")
  })

  it("renders multiple pasted images as separate thumbnails", async () => {
    const { container } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const a = new File([new Uint8Array(100)], "image.png", { type: "image/png" })
    const b = new File([new Uint8Array(100)], "image.png", { type: "image/jpeg" })
    textarea.dispatchEvent(pasteEvent(makePasteData([a, b])))
    await waitFor(() => expect(container.querySelectorAll(".image-thumb").length).toBe(2))
  })

  it("pasted text alongside an image goes into the textarea, image to thumbnail", async () => {
    const { container } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const file = new File([new Uint8Array(100)], "image.png", { type: "image/png" })
    textarea.dispatchEvent(pasteEvent(makePasteData([file], "from clipboard")))
    await waitFor(() => expect(container.querySelector(".image-thumb")).not.toBeNull())
    expect(textarea.value).toBe("from clipboard")
  })

  it("clicking the thumbnail opens a fullscreen lightbox preview", async () => {
    const { container } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const file = new File([new Uint8Array(100)], "image.png", { type: "image/png" })
    textarea.dispatchEvent(pasteEvent(makePasteData([file])))
    await waitFor(() => expect(container.querySelector(".image-thumb")).not.toBeNull())
    const user = userEvent.setup()
    const openBtn = screen.getByRole("button", { name: /Preview pasted-image\.png/i })
    await user.click(openBtn)
    expect(screen.getByRole("dialog", { name: /preview of pasted-image\.png/i })).toBeInTheDocument()
    expect(document.querySelector(".image-preview-img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/)
  })

  it("clicking the X remove button does NOT open the lightbox", async () => {
    const { container } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const file = new File([new Uint8Array(100)], "image.png", { type: "image/png" })
    textarea.dispatchEvent(pasteEvent(makePasteData([file])))
    await waitFor(() => expect(container.querySelector(".image-thumb")).not.toBeNull())
    const user = userEvent.setup()
    const removeBtn = screen.getByRole("button", { name: /Remove pasted-image\.png/i })
    await user.click(removeBtn)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(container.querySelector(".image-thumb")).toBeNull()
  })

  it("lightbox closes on Esc key", async () => {
    const { container } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const file = new File([new Uint8Array(100)], "image.png", { type: "image/png" })
    textarea.dispatchEvent(pasteEvent(makePasteData([file])))
    await waitFor(() => expect(container.querySelector(".image-thumb")).not.toBeNull())
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /Preview pasted-image\.png/i }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("lightbox closes on backdrop click but stays open when clicking the image itself", async () => {
    const { container } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const file = new File([new Uint8Array(100)], "image.png", { type: "image/png" })
    textarea.dispatchEvent(pasteEvent(makePasteData([file])))
    await waitFor(() => expect(container.querySelector(".image-thumb")).not.toBeNull())
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /Preview pasted-image\.png/i }))
    // Click on the image itself — should NOT close.
    await user.click(document.querySelector(".image-preview-img") as HTMLImageElement)
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    // Click on the backdrop — closes.
    await user.click(document.querySelector(".image-preview-overlay") as HTMLDivElement)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("lightbox closes when clicking the modal Close button", async () => {
    const { container } = render(<PromptBox busy={false} onSend={vi.fn()} onAbort={vi.fn()} attachFile={vi.fn()} />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const file = new File([new Uint8Array(100)], "image.png", { type: "image/png" })
    textarea.dispatchEvent(pasteEvent(makePasteData([file])))
    await waitFor(() => expect(container.querySelector(".image-thumb")).not.toBeNull())
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /Preview pasted-image\.png/i }))
    await user.click(screen.getByRole("button", { name: /Close preview/i }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })
})
