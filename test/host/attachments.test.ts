import { describe, it, expect, beforeEach, vi } from "vitest"
import * as vscode from "vscode"
import {
  guessMime,
  isAcceptedExt,
  bytesToDataUrl,
  readAttachment,
  MAX_ATTACHMENT_BYTES,
} from "../../src/attachments"

describe("guessMime", () => {
  it("recognizes common image extensions", () => {
    expect(guessMime("foo.png")).toBe("image/png")
    expect(guessMime("foo.JPG")).toBe("image/jpeg")
    expect(guessMime("foo.jpeg")).toBe("image/jpeg")
    expect(guessMime("foo.gif")).toBe("image/gif")
    expect(guessMime("foo.webp")).toBe("image/webp")
    expect(guessMime("foo.svg")).toBe("image/svg+xml")
  })

  it("recognizes pdf", () => {
    expect(guessMime("doc.pdf")).toBe("application/pdf")
  })

  it("falls back to octet-stream for unknown extensions", () => {
    expect(guessMime("strange.xyz")).toBe("application/octet-stream")
    expect(guessMime("noextension")).toBe("application/octet-stream")
  })
})

describe("isAcceptedExt", () => {
  it("accepts images and pdfs", () => {
    expect(isAcceptedExt("foo.png")).toBe(true)
    expect(isAcceptedExt("foo.PDF")).toBe(true)
  })

  it("accepts code and text files", () => {
    expect(isAcceptedExt("foo.js")).toBe(true)
    expect(isAcceptedExt("foo.TS")).toBe(true)
    expect(isAcceptedExt("foo.py")).toBe(true)
    expect(isAcceptedExt("foo.md")).toBe(true)
    expect(isAcceptedExt("foo.json")).toBe(true)
    expect(isAcceptedExt("foo.txt")).toBe(true)
    expect(isAcceptedExt("foo.yml")).toBe(true)
  })

  it("rejects binary office docs and extensionless files", () => {
    expect(isAcceptedExt("foo.docx")).toBe(false)
    expect(isAcceptedExt("foo.xlsx")).toBe(false)
    expect(isAcceptedExt("foo.exe")).toBe(false)
    expect(isAcceptedExt("foo")).toBe(false)
  })
})

describe("bytesToDataUrl", () => {
  it("encodes a small buffer as data URL", () => {
    const url = bytesToDataUrl("image/png", new Uint8Array([1, 2, 3]))
    expect(url).toBe("data:image/png;base64,AQID")
  })

  it("preserves the mime in the URL", () => {
    expect(bytesToDataUrl("application/pdf", new Uint8Array([0]))).toMatch(/^data:application\/pdf;base64,/)
  })

  it("returns a valid empty payload for empty bytes", () => {
    expect(bytesToDataUrl("image/png", new Uint8Array(0))).toBe("data:image/png;base64,")
  })
})

describe("readAttachment", () => {
  beforeEach(() => {
    vi.mocked(vscode.workspace.fs.readFile).mockReset()
  })

  it("rejects non-image, non-pdf files", async () => {
    const result = await readAttachment(vscode.Uri.file("/x/foo.docx"))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unsupported")
  })

  it("rejects files over the per-file size cap", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
    )
    const result = await readAttachment(vscode.Uri.file("/x/huge.png"))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("oversize")
  })

  it("returns an attachment for a valid image", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
    const result = await readAttachment(vscode.Uri.file("/x/screen.png"))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.attachment.filename).toBe("screen.png")
      expect(result.attachment.mime).toBe("image/png")
      expect(result.attachment.bytes).toBe(3)
      expect(result.attachment.dataUrl).toBe("data:image/png;base64,AQID")
      expect(result.attachment.id).toMatch(/^att_/)
      // sourcePath lets the host emit a file:// URL so opencode can read the
      // file directly — works for files outside the workspace.
      expect(result.attachment.sourcePath).toBe("/x/screen.png")
    }
  })

  it("returns read-failed when fs.readFile rejects", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValueOnce(new Error("EACCES"))
    const result = await readAttachment(vscode.Uri.file("/x/foo.png"))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("read-failed")
  })
})
