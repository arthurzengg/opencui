import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { reducer, initialChatState } from "../../webview/src/hooks/useChatState"
import { ImageThumbnail } from "../../webview/src/components/ImageThumbnail"

afterEach(cleanup)

describe("reducer: storage-backed attachments", () => {
  it("carries storageID onto the attachment block and tolerates a missing dataUrl", () => {
    const state = reducer(initialChatState, {
      type: "userMessage",
      id: "u1",
      text: "resend",
      attachments: [
        { id: "a1", mime: "application/pdf", filename: "doc.pdf", bytes: 10, storageID: "att_ref" },
      ],
    })
    expect(state.messages[0]!.blocks[0]).toMatchObject({
      type: "attachment",
      filename: "doc.pdf",
      storageID: "att_ref",
      dataUrl: undefined,
    })
  })
})

describe("ImageThumbnail without a dataUrl", () => {
  it("renders a file icon instead of a broken img", () => {
    const { container } = render(
      <ImageThumbnail
        attachment={{ mime: "image/png", filename: "gone.png", bytes: 4 }}
        onPreview={() => {}}
      />,
    )
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector(".codicon-file-media")).not.toBeNull()
    // The tile itself still renders with its filename tooltip.
    expect(screen.getByLabelText("Preview gone.png")).toBeInTheDocument()
  })

  it("renders the img when a dataUrl is present", () => {
    const { container } = render(
      <ImageThumbnail
        attachment={{ mime: "image/png", filename: "ok.png", bytes: 4, dataUrl: "data:image/png;base64,AAAA" }}
        onPreview={() => {}}
      />,
    )
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA")
  })
})
