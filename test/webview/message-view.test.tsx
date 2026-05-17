import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MessageView } from "../../webview/src/components/MessageView"
import type { Message } from "../../webview/src/hooks/useChatState"

afterEach(cleanup)

function userMessage(text: string, opts: { id?: string; backendID?: string } = {}): Message {
  return {
    id: opts.id ?? "u1",
    role: "user",
    blocks: [{ type: "text", text }],
    backendID: opts.backendID,
  } as Message
}

function assistantMessage(text: string, opts: { id?: string; pending?: boolean } = {}): Message {
  return {
    id: opts.id ?? "a1",
    role: "assistant",
    blocks: text ? [{ type: "text", text }] : [],
    pending: opts.pending,
  } as Message
}

describe("MessageView (user role)", () => {
  it("renders the user message text", () => {
    render(
      <MessageView
        message={userMessage("hello world")}
        processOpen={false}
        processOnly={false}
      />,
    )
    expect(screen.getByText("hello world")).toBeInTheDocument()
  })

  it("renders edit hint icon when an onEditMessage handler is provided", () => {
    const { container } = render(
      <MessageView
        message={userMessage("hi", { backendID: "b1" })}
        processOpen={false}
        processOnly={false}
        onEditMessage={vi.fn()}
      />,
    )
    expect(container.querySelector(".user-edit-hint")).not.toBeNull()
  })

  it("opens edit mode when bubble is clicked (editable state)", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MessageView
        message={userMessage("hi", { backendID: "b1" })}
        processOpen={false}
        processOnly={false}
        onEditMessage={vi.fn()}
      />,
    )
    const bubble = container.querySelector(".msg.role-user") as HTMLElement
    await user.click(bubble)
    // Now in edit mode — textarea should appear
    expect(container.querySelector("textarea")).not.toBeNull()
    expect(screen.getByRole("button", { name: /save .{0,3}regenerate/i })).toBeInTheDocument()
  })

  it("does NOT enter edit mode while busy", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MessageView
        message={userMessage("hi", { backendID: "b1" })}
        processOpen={false}
        processOnly={false}
        busy={true}
        onEditMessage={vi.fn()}
      />,
    )
    const bubble = container.querySelector(".msg.role-user") as HTMLElement
    await user.click(bubble)
    expect(container.querySelector("textarea")).toBeNull()
  })

  it("does NOT enter edit mode without backendID", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MessageView
        message={userMessage("hi")} // no backendID
        processOpen={false}
        processOnly={false}
        onEditMessage={vi.fn()}
      />,
    )
    const bubble = container.querySelector(".msg.role-user") as HTMLElement
    await user.click(bubble)
    expect(container.querySelector("textarea")).toBeNull()
  })

  it("calls onEditMessage when Save & regenerate is clicked with a changed value", async () => {
    const user = userEvent.setup()
    const onEditMessage = vi.fn()
    const { container } = render(
      <MessageView
        message={userMessage("original", { id: "u-edit", backendID: "b1" })}
        processOpen={false}
        processOnly={false}
        onEditMessage={onEditMessage}
      />,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    await user.clear(textarea)
    await user.type(textarea, "updated text")
    await user.click(screen.getByRole("button", { name: /save .{0,3}regenerate/i }))
    expect(onEditMessage).toHaveBeenCalledWith("u-edit", "updated text", undefined, undefined)
  })

  it("clicking Save with unchanged content does NOT fire onEditMessage", async () => {
    const user = userEvent.setup()
    const onEditMessage = vi.fn()
    const { container } = render(
      <MessageView
        message={userMessage("same text", { backendID: "b1" })}
        processOpen={false}
        processOnly={false}
        onEditMessage={onEditMessage}
      />,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    await user.click(screen.getByRole("button", { name: /save .{0,3}regenerate/i }))
    // No regenerate triggered, edit mode closed.
    expect(onEditMessage).not.toHaveBeenCalled()
    expect(container.querySelector("textarea")).toBeNull()
  })

  it("clicking outside the edit area cancels without firing onEditMessage", async () => {
    const user = userEvent.setup()
    const onEditMessage = vi.fn()
    const { container } = render(
      <div>
        <div data-testid="outside">outside the bubble</div>
        <MessageView
          message={userMessage("hi", { backendID: "b1" })}
          processOpen={false}
          processOnly={false}
          onEditMessage={onEditMessage}
        />
      </div>,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    expect(container.querySelector("textarea")).not.toBeNull()
    // A click anywhere outside the editing container should cancel edit
    // mode — there is no Cancel button anymore.
    await user.click(screen.getByTestId("outside"))
    expect(container.querySelector("textarea")).toBeNull()
    expect(onEditMessage).not.toHaveBeenCalled()
  })

  it("Escape key in textarea cancels edit mode", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MessageView
        message={userMessage("hi", { backendID: "b1" })}
        processOpen={false}
        processOnly={false}
        onEditMessage={vi.fn()}
      />,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    textarea.focus()
    await user.keyboard("{Escape}")
    expect(container.querySelector("textarea")).toBeNull()
  })

  it("Cmd+Enter in textarea fires Save with the new content", async () => {
    const user = userEvent.setup()
    const onEditMessage = vi.fn()
    const { container } = render(
      <MessageView
        message={userMessage("orig", { id: "u-cmd", backendID: "b1" })}
        processOpen={false}
        processOnly={false}
        onEditMessage={onEditMessage}
      />,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    await user.clear(textarea)
    await user.type(textarea, "via shortcut")
    await user.keyboard("{Meta>}{Enter}{/Meta}")
    expect(onEditMessage).toHaveBeenCalledWith("u-cmd", "via shortcut", undefined, undefined)
  })

  it("renders the editor-context label when message has ref", () => {
    render(
      <MessageView
        message={{ ...userMessage("hi"), ref: { label: "src/foo.ts" } } as Message}
        processOpen={false}
        processOnly={false}
      />,
    )
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument()
  })
})

describe("MessageView (assistant role)", () => {
  it("renders thinking indicator when message is pending and has no blocks", () => {
    render(
      <MessageView
        message={assistantMessage("", { pending: true })}
        processOpen={false}
        processOnly={false}
      />,
    )
    expect(screen.getByText("thinking")).toBeInTheDocument()
  })

  it("renders error text when message has error", () => {
    const msg = { ...assistantMessage(""), error: "AI error happened" } as Message
    render(<MessageView message={msg} processOpen={false} processOnly={false} />)
    expect(screen.getByText("AI error happened")).toBeInTheDocument()
  })

  it("renders model + cost + token usage when present", () => {
    const msg = {
      ...assistantMessage("response"),
      usage: { model: "claude-opus-4-7", cost: 0.0025, tokens: { input: 100, output: 50, reasoning: 0 } },
    } as Message
    render(<MessageView message={msg} processOpen={false} processOnly={false} />)
    expect(screen.getByText("claude-opus-4-7")).toBeInTheDocument()
    expect(screen.getByText(/0\.0025/)).toBeInTheDocument()
    expect(screen.getByText(/150 tokens/)).toBeInTheDocument()
  })
})

describe("MessageView edit preserves mentions + attachments", () => {
  function userWithMentions(text: string, mentions: string[], opts: { id?: string; backendID?: string } = {}): Message {
    return {
      id: opts.id ?? "u-mention",
      role: "user",
      blocks: [{ type: "text", text }],
      backendID: opts.backendID ?? "b1",
      mentions,
    } as Message
  }

  function userWithAttachment(
    text: string,
    attachment: { mime: string; filename: string; dataUrl: string; bytes: number },
    opts: { id?: string } = {},
  ): Message {
    return {
      id: opts.id ?? "u-att",
      role: "user",
      blocks: [
        { type: "attachment", ...attachment },
        { type: "text", text },
      ],
      backendID: "b1",
    } as Message
  }

  it("forwards preserved mentions whose token still appears in the edited text", async () => {
    const user = userEvent.setup()
    const onEditMessage = vi.fn()
    const message = userWithMentions("@src/foo.ts please explain", ["src/foo.ts"])
    const { container } = render(
      <MessageView
        message={message}
        processOpen={false}
        processOnly={false}
        onEditMessage={onEditMessage}
      />,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    await user.clear(textarea)
    await user.type(textarea, "@src/foo.ts rewrite it")
    await user.click(screen.getByRole("button", { name: /save .{0,3}regenerate/i }))
    expect(onEditMessage).toHaveBeenCalledWith("u-mention", "@src/foo.ts rewrite it", ["src/foo.ts"], undefined)
  })

  it("drops mentions whose @token was deleted in the edited text", async () => {
    const user = userEvent.setup()
    const onEditMessage = vi.fn()
    const message = userWithMentions("@src/foo.ts something", ["src/foo.ts"])
    const { container } = render(
      <MessageView
        message={message}
        processOpen={false}
        processOnly={false}
        onEditMessage={onEditMessage}
      />,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    await user.clear(textarea)
    await user.type(textarea, "no mentions here")
    await user.click(screen.getByRole("button", { name: /save .{0,3}regenerate/i }))
    expect(onEditMessage).toHaveBeenCalledWith("u-mention", "no mentions here", undefined, undefined)
  })

  it("re-derives attachments and forwards them when their label is still in the text", async () => {
    const user = userEvent.setup()
    const onEditMessage = vi.fn()
    const att = {
      mime: "image/png",
      filename: "screen.png",
      dataUrl: "data:image/png;base64,AQID",
      bytes: 3,
    }
    const message = userWithAttachment("@screen.png look at this", att)
    const { container } = render(
      <MessageView
        message={message}
        processOpen={false}
        processOnly={false}
        onEditMessage={onEditMessage}
      />,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    await user.clear(textarea)
    await user.type(textarea, "@screen.png what is this")
    await user.click(screen.getByRole("button", { name: /save .{0,3}regenerate/i }))
    expect(onEditMessage).toHaveBeenCalledTimes(1)
    const call = onEditMessage.mock.calls[0]
    expect(call?.[0]).toBe("u-att")
    expect(call?.[1]).toBe("@screen.png what is this")
    expect(call?.[2]).toBeUndefined()
    expect(call?.[3]).toHaveLength(1)
    expect(call?.[3]?.[0]?.filename).toBe("screen.png")
    expect(call?.[3]?.[0]?.dataUrl).toBe("data:image/png;base64,AQID")
  })

  it("renders @path tokens as .mention-chip spans in the read-only bubble", () => {
    const message: Message = {
      id: "u-render",
      role: "user",
      blocks: [{ type: "text", text: "look at @src/foo.ts please" }],
      backendID: "b1",
      mentions: ["src/foo.ts"],
    } as Message
    const { container } = render(
      <MessageView message={message} processOpen={false} processOnly={false} />,
    )
    const chip = container.querySelector(".user-text .mention-chip")
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe("@src/foo.ts")
  })

  it("renders a neutral grey Stopped badge for stopped assistant messages", () => {
    const message: Message = {
      id: "a-stop",
      role: "assistant",
      blocks: [{ type: "text", text: "I was working on this when…" }],
      stopped: true,
    } as Message
    const { container } = render(
      <MessageView message={message} processOpen={false} processOnly={false} />,
    )
    const badge = container.querySelector(".msg-stopped")
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toBe("Stopped")
    // Should NOT render the red .msg-error block.
    expect(container.querySelector(".msg-error")).toBeNull()
  })

  it("stopped overrides error: shows only Stopped when both fields are set", () => {
    // Race-state message: it has both the new stopped flag AND an old "Aborted"
    // error string. Should render exactly one Stopped badge, no red block.
    const message: Message = {
      id: "a-both",
      role: "assistant",
      blocks: [],
      stopped: true,
      error: "Aborted",
    } as Message
    const { container } = render(
      <MessageView message={message} processOpen={false} processOnly={false} />,
    )
    expect(container.querySelectorAll(".msg-stopped")).toHaveLength(1)
    expect(container.querySelector(".msg-error")).toBeNull()
  })

  it("legacy: error='Aborted' (without stopped flag) renders as Stopped", () => {
    // Persisted message from before the abort fix shipped: only carries the
    // old red `error: "Aborted"` string. Treat it as Stopped.
    const message: Message = {
      id: "a-legacy",
      role: "assistant",
      blocks: [],
      error: "Aborted",
    } as Message
    const { container } = render(
      <MessageView message={message} processOpen={false} processOnly={false} />,
    )
    expect(container.querySelector(".msg-stopped")).not.toBeNull()
    expect(container.querySelector(".msg-error")).toBeNull()
  })

  it("real errors (not Aborted) still render in the red error block", () => {
    const message: Message = {
      id: "a-err",
      role: "assistant",
      blocks: [],
      error: "Network connection lost",
    } as Message
    const { container } = render(
      <MessageView message={message} processOpen={false} processOnly={false} />,
    )
    expect(container.querySelector(".msg-stopped")).toBeNull()
    const err = container.querySelector(".msg-error")
    expect(err).not.toBeNull()
    expect(err!.textContent).toBe("Network connection lost")
  })

  it("renders image attachments in the bubble as bare thumbnails (no filename text)", () => {
    const message: Message = {
      id: "u-img-att",
      role: "user",
      blocks: [
        { type: "attachment", mime: "image/png", filename: "pasted-image.png", dataUrl: "data:image/png;base64,A", bytes: 100 },
        { type: "text", text: "what's in this" },
      ],
      backendID: "b1",
    } as Message
    const { container } = render(
      <MessageView message={message} processOpen={false} processOnly={false} />,
    )
    const tile = container.querySelector(".attachment-image") as HTMLElement | null
    expect(tile).not.toBeNull()
    // No chip pill, no filename text — the image is the affordance.
    expect(container.querySelector(".attachment-tile")).toBeNull()
    expect(tile?.textContent?.trim()).toBe("")
    // Filename + size still discoverable via the tooltip.
    expect(tile?.getAttribute("title")).toBe("pasted-image.png")
    // The image itself uses the data URL.
    const img = tile?.querySelector("img") as HTMLImageElement | null
    expect(img?.getAttribute("src")).toMatch(/^data:image\/png;base64,/)
  })

  it("clicking the sent-bubble image thumbnail opens the lightbox (and does NOT start edit)", async () => {
    const user = userEvent.setup()
    const onEditMessage = vi.fn()
    const message: Message = {
      id: "u-img-click",
      role: "user",
      blocks: [
        { type: "attachment", mime: "image/png", filename: "pasted-image.png", dataUrl: "data:image/png;base64,A", bytes: 100 },
        { type: "text", text: "describe this" },
      ],
      backendID: "b1",
    } as Message
    render(
      <MessageView
        message={message}
        processOpen={false}
        processOnly={false}
        onEditMessage={onEditMessage}
      />,
    )
    await user.click(screen.getByRole("button", { name: /Preview pasted-image\.png/i }))
    expect(screen.getByRole("dialog", { name: /preview of pasted-image\.png/i })).toBeInTheDocument()
    // Bubble must not have flipped into edit mode (no textarea rendered).
    expect(document.querySelector("textarea")).toBeNull()
  })

  it("non-image attachments keep the chip-pill tile with filename + badge", () => {
    const message: Message = {
      id: "u-pdf-att",
      role: "user",
      blocks: [
        { type: "attachment", mime: "application/pdf", filename: "spec.pdf", dataUrl: "data:application/pdf;base64,A", bytes: 100 },
        { type: "text", text: "summarize" },
      ],
      backendID: "b1",
    } as Message
    const { container } = render(
      <MessageView message={message} processOpen={false} processOnly={false} />,
    )
    const chip = container.querySelector(".attachment-tile") as HTMLElement | null
    expect(chip).not.toBeNull()
    // The filename still shows for non-image attachments — these come from
    // the paperclip flow and carry user-meaningful names.
    expect(chip?.textContent).toContain("spec.pdf")
    expect(container.querySelector(".attachment-image")).toBeNull()
  })

  it("renders an attachment label as a chip in the read-only bubble too", () => {
    const message: Message = {
      id: "u-att-chip",
      role: "user",
      blocks: [
        { type: "attachment", mime: "image/png", filename: "screen.png", dataUrl: "data:image/png;base64,A", bytes: 1 },
        { type: "text", text: "@screen.png describe this" },
      ],
      backendID: "b1",
    } as Message
    const { container } = render(
      <MessageView message={message} processOpen={false} processOnly={false} />,
    )
    const chip = container.querySelector(".user-text .mention-chip")
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe("@screen.png")
  })

  it("drops non-image attachments whose chip label was deleted from the text", async () => {
    // Non-image (PDF / code / .txt) attachments use the @chip text-token
    // model: removing the chip from the text drops the attachment on send.
    // Image attachments use the thumbnail strip and persist independently
    // (see the next test) — they only drop via the X button.
    const user = userEvent.setup()
    const onEditMessage = vi.fn()
    const att = {
      mime: "application/pdf",
      filename: "spec.pdf",
      dataUrl: "data:application/pdf;base64,AQID",
      bytes: 3,
    }
    const message = userWithAttachment("@spec.pdf describe", att)
    const { container } = render(
      <MessageView
        message={message}
        processOpen={false}
        processOnly={false}
        onEditMessage={onEditMessage}
      />,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    await user.clear(textarea)
    await user.type(textarea, "no attachments now")
    await user.click(screen.getByRole("button", { name: /save .{0,3}regenerate/i }))
    expect(onEditMessage).toHaveBeenCalledWith("u-att", "no attachments now", undefined, undefined)
  })

  it("image attachments seed the thumbnail strip in edit mode (not dropped silently)", async () => {
    // Regression: pre-fix, image attachments from initial.attachments went
    // into knownAttachments which required an @chip text token to match.
    // Post-fix pasted images carry no @chip in the text, so the image was
    // silently dropped on edit. Now they seed the thumbnail strip directly
    // and are forwarded on submit regardless of text edits.
    const user = userEvent.setup()
    const onEditMessage = vi.fn()
    const att = {
      mime: "image/png",
      filename: "pasted-image.png",
      dataUrl: "data:image/png;base64,AQID",
      bytes: 3,
    }
    const message: Message = {
      id: "u-thumb",
      role: "user",
      blocks: [
        { type: "attachment", ...att },
        { type: "text", text: "what is this" },
      ],
      backendID: "b1",
    } as Message
    const { container } = render(
      <MessageView
        message={message}
        processOpen={false}
        processOnly={false}
        onEditMessage={onEditMessage}
      />,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    // Thumbnail visible inside the edit bubble's PromptBox.
    expect(container.querySelector(".promptbox-thumb")).not.toBeNull()
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    await user.clear(textarea)
    await user.type(textarea, "describe this image")
    await user.click(screen.getByRole("button", { name: /save .{0,3}regenerate/i }))
    expect(onEditMessage).toHaveBeenCalledTimes(1)
    const call = onEditMessage.mock.calls[0]
    expect(call?.[1]).toBe("describe this image")
    expect(call?.[3]).toHaveLength(1)
    expect(call?.[3]?.[0]?.filename).toBe("pasted-image.png")
    expect(call?.[3]?.[0]?.dataUrl).toBe("data:image/png;base64,AQID")
  })

  it("image attachment is dropped when the user removes it via the strip X button", async () => {
    const user = userEvent.setup()
    const onEditMessage = vi.fn()
    const att = {
      mime: "image/png",
      filename: "pasted-image.png",
      dataUrl: "data:image/png;base64,AQID",
      bytes: 3,
    }
    const message: Message = {
      id: "u-thumb-rm",
      role: "user",
      blocks: [
        { type: "attachment", ...att },
        { type: "text", text: "what is this" },
      ],
      backendID: "b1",
    } as Message
    const { container } = render(
      <MessageView
        message={message}
        processOpen={false}
        processOnly={false}
        onEditMessage={onEditMessage}
      />,
    )
    await user.click(container.querySelector(".msg.role-user") as HTMLElement)
    const removeBtn = screen.getByRole("button", { name: /Remove pasted-image\.png/i })
    await user.click(removeBtn)
    expect(container.querySelector(".promptbox-thumb")).toBeNull()
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    await user.clear(textarea)
    await user.type(textarea, "no image now")
    await user.click(screen.getByRole("button", { name: /save .{0,3}regenerate/i }))
    expect(onEditMessage).toHaveBeenCalledWith("u-thumb-rm", "no image now", undefined, undefined)
  })
})
