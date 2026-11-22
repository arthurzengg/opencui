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

  // The turn's usage is summed anew whenever any message changes, so it is
  // compared by its figures: by identity, every delta would re-render the last
  // reply of every turn (#792).
  it("compares the turn's usage by its figures", () => {
    const usage = { cost: 0.25, tokens: { input: 2, output: 20, reasoning: 0 } }
    expect(sameMessageViewProps({ ...base, turnUsage: usage }, { ...base, turnUsage: { ...usage, tokens: { ...usage.tokens } } })).toBe(true)
    expect(sameMessageViewProps({ ...base, turnUsage: usage }, { ...base, turnUsage: { ...usage, cost: 0.3 } })).toBe(false)
  })

  it("returns false when agentActivityEntering flips (#674)", () => {
    expect(
      sameMessageViewProps({ ...base, agentActivityEntering: false }, { ...base, agentActivityEntering: true }),
    ).toBe(false)
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
