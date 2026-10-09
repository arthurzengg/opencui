import { describe, it, expect } from "vitest"
import { reducer, initialChatState } from "../../webview/src/hooks/useChatState"

describe("reducer setComposerText", () => {
  it("sets injectedText with an incrementing nonce so identical text re-applies", () => {
    const s1 = reducer(initialChatState, { type: "setComposerText", text: "hello" })
    expect(s1.injectedText).toEqual({ text: "hello", nonce: 1, mode: "set" })
    const s2 = reducer(s1, { type: "setComposerText", text: "hello" })
    expect(s2.injectedText).toEqual({ text: "hello", nonce: 2, mode: "set" })
  })

  it("clears the pending inject when the user sends (userMessage)", () => {
    const s1 = reducer(initialChatState, { type: "setComposerText", text: "draft" })
    const s2 = reducer(s1, { type: "userMessage", id: "u1", text: "sent" })
    expect(s2.injectedText).toBeUndefined()
  })

  it("clears the pending inject on a conversation restore", () => {
    const s1 = reducer(initialChatState, { type: "setComposerText", text: "draft" })
    const s2 = reducer(s1, { type: "restore", conversationID: "c1", messages: [] })
    expect(s2.injectedText).toBeUndefined()
  })

  it("carries an injected mention alongside the text", () => {
    const s1 = reducer(initialChatState, {
      type: "setComposerText",
      text: "@src/foo.ts#L5-9 ",
      mention: "src/foo.ts#L5-9",
    })
    expect(s1.injectedMention).toBe("src/foo.ts#L5-9")
    const s2 = reducer(s1, { type: "userMessage", id: "u1", text: "sent" })
    expect(s2.injectedMention).toBeUndefined()
    const s3 = reducer(s1, { type: "restore", conversationID: "c1", messages: [] })
    expect(s3.injectedMention).toBeUndefined()
  })
})

describe("reducer appendComposerText", () => {
  it("sets injectedText with mode: append and increments nonce", () => {
    const s1 = reducer(initialChatState, { type: "appendComposerText", text: "@src/foo.ts " })
    expect(s1.injectedText).toEqual({ text: "@src/foo.ts ", nonce: 1, mode: "append" })
    const s2 = reducer(s1, { type: "appendComposerText", text: "@src/bar.ts " })
    expect(s2.injectedText).toEqual({ text: "@src/bar.ts ", nonce: 2, mode: "append" })
  })

  it("carries an injected mention alongside the append", () => {
    const s1 = reducer(initialChatState, {
      type: "appendComposerText",
      text: "@src/foo.ts#L5-9 ",
      mention: "src/foo.ts#L5-9",
    })
    expect(s1.injectedMention).toBe("src/foo.ts#L5-9")
  })
})
