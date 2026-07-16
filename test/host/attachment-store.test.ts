import { describe, it, expect } from "vitest"
import * as vscode from "vscode"
import { AttachmentStore, dataUrlToBytes } from "../../src/chat/attachment-store"
import {
  adoptStorageIDs,
  attachmentStorageIDs,
  stripAttachmentDataForPersist,
  type SavedConversation,
} from "../../src/chat/conversation-store"
import type { ChatMessage } from "../../src/protocol"

const fsFiles = (vscode as unknown as { __fsFiles: Map<string, Uint8Array> }).__fsFiles

describe("dataUrlToBytes", () => {
  it("round-trips base64 payloads", () => {
    const bytes = new Uint8Array([1, 2, 250, 0, 7])
    const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`
    expect(dataUrlToBytes(dataUrl)).toEqual(bytes)
  })

  it("rejects non-base64 and malformed data URLs", () => {
    expect(dataUrlToBytes("data:text/plain,hello")).toBeUndefined()
    expect(dataUrlToBytes("not a data url")).toBeUndefined()
  })
})

describe("AttachmentStore", () => {
  it("saves bytes under the attachments dir and reads them back", async () => {
    const store = new AttachmentStore(vscode.Uri.file("/store-base"))
    const bytes = new Uint8Array([9, 8, 7])
    const storageID = await store.save(bytes)
    expect(storageID).toMatch(/^att_/)
    expect(fsFiles.get(`file:///store-base/attachments/${storageID}`)).toEqual(bytes)
    expect(await store.read(storageID!)).toEqual(bytes)
    await store.delete(storageID!)
    expect(fsFiles.has(`file:///store-base/attachments/${storageID}`)).toBe(false)
  })

  it("is a no-op without a storage root", async () => {
    const store = new AttachmentStore(undefined)
    expect(await store.save(new Uint8Array([1]))).toBeUndefined()
    expect(store.uriFor("att_x")).toBeUndefined()
  })

  it("refuses storageIDs that could escape the attachments dir", () => {
    const store = new AttachmentStore(vscode.Uri.file("/store-base"))
    expect(store.uriFor("../evil")).toBeUndefined()
    expect(store.uriFor("a/b")).toBeUndefined()
    expect(store.uriFor("att_ok-1_x")).toBeDefined()
  })
})

function conv(messages: ChatMessage[]): SavedConversation {
  return { id: "c1", title: "t", createdAt: 1, updatedAt: 1, messages }
}

function attachmentMessage(block: Record<string, unknown>): ChatMessage {
  return {
    id: "u1",
    role: "user",
    blocks: [
      { type: "attachment", mime: "image/png", filename: "a.png", bytes: 3, ...block },
      { type: "text", text: "hi" },
    ],
  } as ChatMessage
}

describe("stripAttachmentDataForPersist", () => {
  it("drops dataUrl only when a storageID references the bytes", () => {
    const stored = attachmentMessage({ dataUrl: "data:image/png;base64,AAAA", storageID: "att_1" })
    const legacy = { ...attachmentMessage({ dataUrl: "data:image/png;base64,BBBB" }), id: "u2" }
    const [stripped] = stripAttachmentDataForPersist([conv([stored, legacy])])
    const [strippedStored, strippedLegacy] = stripped!.messages
    expect(strippedStored!.blocks[0]).toMatchObject({ storageID: "att_1", dataUrl: undefined })
    expect(strippedLegacy!.blocks[0]).toMatchObject({ dataUrl: "data:image/png;base64,BBBB" })
  })

  it("returns the same conversation object when nothing needs stripping", () => {
    const c = conv([attachmentMessage({ storageID: "att_1" })])
    const [out] = stripAttachmentDataForPersist([c])
    expect(out).toBe(c)
  })
})

describe("attachmentStorageIDs / adoptStorageIDs", () => {
  it("collects every storage reference in a message list", () => {
    const messages = [
      attachmentMessage({ storageID: "att_a" }),
      { ...attachmentMessage({}), id: "u2" },
      { ...attachmentMessage({ storageID: "att_b" }), id: "u3" },
    ]
    expect(attachmentStorageIDs(messages)).toEqual(["att_a", "att_b"])
  })

  it("copies freshly-minted storageIDs onto the live copy by id + position", () => {
    const live = [attachmentMessage({ dataUrl: "data:image/png;base64,AAAA" })]
    const migrated = [attachmentMessage({ dataUrl: "data:image/png;base64,AAAA", storageID: "att_new" })]
    const adopted = adoptStorageIDs(live, migrated)
    expect(adopted[0]!.blocks[0]).toMatchObject({ storageID: "att_new", dataUrl: "data:image/png;base64,AAAA" })
    // Messages the migration never touched keep their identity.
    const untouched = adoptStorageIDs(live, [{ ...attachmentMessage({}), id: "other" }])
    expect(untouched[0]).toBe(live[0])
  })
})
