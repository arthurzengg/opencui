import { describe, it, expect } from "vitest"
import { reducer, initialChatState } from "../../webview/src/hooks/useChatState"

function opened(id = "perm_1") {
  return reducer(initialChatState, { type: "permission", id, title: "Edit file" })
}

describe("reducer — permission flow", () => {
  it("permissionResolved clears the matching pendingPermission", () => {
    const closed = reducer(opened(), { type: "permissionResolved", id: "perm_1" })
    expect(closed.pendingPermission).toBeUndefined()
  })

  it("permissionResolved with a non-matching id is a no-op", () => {
    // The echo of our own reply to A can land after B is already showing;
    // dismissing on arrival alone would drop a prompt nobody answered.
    const stale = reducer(opened("perm_active"), { type: "permissionResolved", id: "perm_other" })
    expect(stale.pendingPermission?.id).toBe("perm_active")
  })

  it("clearPermission clears the matching pendingPermission", () => {
    const closed = reducer(opened(), { type: "clearPermission", id: "perm_1" })
    expect(closed.pendingPermission).toBeUndefined()
  })

  it("ignores a permission raised while aborting", () => {
    const aborting = reducer(initialChatState, { type: "aborted" })
    const after = reducer(aborting, { type: "permission", id: "perm_1", title: "Edit file" })
    expect(after.pendingPermission).toBeUndefined()
  })
})
