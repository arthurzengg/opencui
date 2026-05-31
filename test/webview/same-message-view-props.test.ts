import { describe, it, expect } from "vitest"
import { sameMessageViewProps } from "../../webview/src/components/MessageView"
import type { Message } from "../../webview/src/hooks/useChatState"
import type { AgentsStatusInfo } from "../../webview/src/protocol"

const msg = { id: "a1", role: "assistant", blocks: [] } as Message
const base = { message: msg, processOpen: false, processOnly: false }

describe("sameMessageViewProps", () => {
  it("returns true when render-affecting props are identical", () => {
    expect(sameMessageViewProps({ ...base }, { ...base })).toBe(true)
  })

  it("ignores differing function props — they are fresh closures every render", () => {
    expect(
      sameMessageViewProps(
        { ...base, onEditMessage: () => {}, onReviewFile: () => {} },
        { ...base, onEditMessage: () => {}, onReviewFile: () => {} },
      ),
    ).toBe(true)
  })

  it("returns false when the message object identity changes (a delta landed)", () => {
    expect(sameMessageViewProps(base, { ...base, message: { ...msg } as Message })).toBe(false)
  })

  it("returns false when busy flips", () => {
    expect(sameMessageViewProps({ ...base, busy: false }, { ...base, busy: true })).toBe(false)
  })

  it("returns false when agentActivity changes", () => {
    expect(
      sameMessageViewProps(
        { ...base, agentActivity: undefined },
        { ...base, agentActivity: { total: 1, running: 1 } as AgentsStatusInfo },
      ),
    ).toBe(false)
  })
})
