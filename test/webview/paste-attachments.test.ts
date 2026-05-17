import { describe, it, expect } from "vitest"
import { clipboardHasImage, readPastedImages, PASTE_MAX_BYTES } from "../../webview/src/paste-attachments"

// Build a DataTransfer-shaped stub. jsdom's DataTransfer doesn't expose
// .items / .files in a way that matches the runtime spec for clipboard
// paste, so we hand-roll the minimum surface our helper reads. Each
// `item` is `{ kind, type, getAsFile }`; `getData` returns the text
// payload (defaults to "").
type StubItem = { kind: string; type: string; getAsFile: () => File | null }
function makeData(items: StubItem[], text = ""): DataTransfer {
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

function makeImageFile(bytes: number, mime = "image/png", name = "image.png"): File {
  // Buffer-of-zeros file; we never decode the content, only measure size.
  return new File([new Uint8Array(bytes)], name, { type: mime })
}

function makeItem(file: File, kind = "file"): StubItem {
  return { kind, type: file.type, getAsFile: () => file }
}

describe("clipboardHasImage", () => {
  it("returns true when any item is a file with an accepted image MIME", () => {
    const data = makeData([makeItem(makeImageFile(100, "image/png"))])
    expect(clipboardHasImage(data)).toBe(true)
  })

  it("returns false for plain-text-only clipboards", () => {
    const data = makeData([{ kind: "string", type: "text/plain", getAsFile: () => null }], "hello")
    expect(clipboardHasImage(data)).toBe(false)
  })

  it("ignores file items with non-image MIME types (PDFs, .txt, etc.)", () => {
    const pdf = new File([new Uint8Array(10)], "x.pdf", { type: "application/pdf" })
    const data = makeData([makeItem(pdf)])
    expect(clipboardHasImage(data)).toBe(false)
  })

  it("returns false for null / undefined", () => {
    expect(clipboardHasImage(null)).toBe(false)
    expect(clipboardHasImage(undefined)).toBe(false)
  })

  it("accepts each supported MIME type", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/svg+xml"]) {
      const data = makeData([makeItem(makeImageFile(50, mime))])
      expect(clipboardHasImage(data), `mime ${mime}`).toBe(true)
    }
  })
})

describe("readPastedImages", () => {
  it("returns one Attachment per image, with a synthesized filename", async () => {
    const data = makeData([makeItem(makeImageFile(200, "image/png"))])
    const result = await readPastedImages(data)
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]!.filename).toBe("pasted-image.png")
    expect(result.attachments[0]!.mime).toBe("image/png")
    expect(result.attachments[0]!.bytes).toBe(200)
    expect(result.attachments[0]!.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(result.error).toBeUndefined()
  })

  it("uses JPG/GIF/WEBP/BMP/SVG extensions per mime", async () => {
    const cases: Array<[string, string]> = [
      ["image/jpeg", "jpg"],
      ["image/gif", "gif"],
      ["image/webp", "webp"],
      ["image/bmp", "bmp"],
      ["image/svg+xml", "svg"],
    ]
    for (const [mime, ext] of cases) {
      const data = makeData([makeItem(makeImageFile(50, mime))])
      const result = await readPastedImages(data)
      expect(result.attachments[0]!.filename, `mime ${mime}`).toBe(`pasted-image.${ext}`)
    }
  })

  it("numbers multiple pasted images sequentially (pasted-image, pasted-image-2, …)", async () => {
    const data = makeData([
      makeItem(makeImageFile(100, "image/png")),
      makeItem(makeImageFile(100, "image/jpeg")),
      makeItem(makeImageFile(100, "image/gif")),
    ])
    const result = await readPastedImages(data)
    expect(result.attachments.map((a) => a.filename)).toEqual([
      "pasted-image.png",
      "pasted-image-2.jpg",
      "pasted-image-3.gif",
    ])
  })

  it("skips and reports images over PASTE_MAX_BYTES", async () => {
    const data = makeData([
      makeItem(makeImageFile(100, "image/png")),
      makeItem(makeImageFile(PASTE_MAX_BYTES + 1, "image/png")),
    ])
    const result = await readPastedImages(data)
    expect(result.attachments).toHaveLength(1)
    expect(result.error).toMatch(/Skipped/)
    expect(result.error).toMatch(/over 10 MB/)
  })

  it("returns text from clipboardData.getData('text/plain')", async () => {
    const data = makeData([makeItem(makeImageFile(50, "image/png"))], "look at this")
    const result = await readPastedImages(data)
    expect(result.text).toBe("look at this")
    expect(result.attachments).toHaveLength(1)
  })

  it("skips items that aren't images (text items, unsupported mimes)", async () => {
    const txtItem: StubItem = {
      kind: "string",
      type: "text/plain",
      getAsFile: () => null,
    }
    const data = makeData([txtItem, makeItem(makeImageFile(50, "image/png"))], "ignore me")
    const result = await readPastedImages(data)
    expect(result.attachments).toHaveLength(1)
  })

  it("generates a unique id per attachment", async () => {
    const data = makeData([
      makeItem(makeImageFile(100, "image/png")),
      makeItem(makeImageFile(100, "image/png")),
    ])
    const result = await readPastedImages(data)
    const ids = result.attachments.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith("att_paste_"))).toBe(true)
  })
})
