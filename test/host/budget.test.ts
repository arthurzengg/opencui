import { describe, it, expect } from "vitest"
import {
  applyAutoContextBudget,
  readContextSettings,
  DEFAULT_CONTEXT_SETTINGS,
} from "../../src/workspace-context/budget"
import type { PromptContextBlock } from "../../src/workspace-context/types"
import type { PromptContextManifestItem } from "../../src/protocol"

function block(id: string, itemID: string, bytes: number, priority: number): PromptContextBlock {
  return {
    id,
    itemID,
    title: id,
    content: "x".repeat(bytes),
    bytes,
    priority,
  }
}

function item(id: string, priority: number, bytes: number): PromptContextManifestItem {
  return {
    id,
    source: "openTab",
    kind: "summary",
    label: id,
    reason: "Test",
    status: "included",
    bytes,
    priority,
  }
}

describe("applyAutoContextBudget", () => {
  it("returns everything when the total fits the budget", () => {
    const blocks = [block("a", "i1", 100, 1), block("b", "i2", 100, 2)]
    const items = [item("i1", 1, 100), item("i2", 2, 100)]
    const out = applyAutoContextBudget(blocks, items, { maxAutoBytes: 500 })
    expect(out.blocks).toHaveLength(2)
    expect(out.droppedBytes).toBe(0)
    expect(out.items.every((i) => i.status === "included")).toBe(true)
  })

  it("drops lower-priority blocks first and marks their items skipped", () => {
    const blocks = [
      block("a", "i1", 100, 1), // highest priority (smallest number)
      block("b", "i2", 200, 5),
      block("c", "i3", 200, 9), // lowest priority — drops first
    ]
    const items = [item("i1", 1, 100), item("i2", 5, 200), item("i3", 9, 200)]
    const out = applyAutoContextBudget(blocks, items, { maxAutoBytes: 350 })
    expect(out.blocks.map((b) => b.id)).toEqual(["a", "b"])
    expect(out.droppedBytes).toBe(200)
    const dropped = out.items.find((i) => i.id === "i3")
    expect(dropped?.status).toBe("skipped")
    expect(dropped?.reason).toContain("over per-prompt auto-context budget")
  })

  it("does not slice individual blocks", () => {
    const blocks = [block("a", "i1", 200, 1)]
    const items = [item("i1", 1, 200)]
    const out = applyAutoContextBudget(blocks, items, { maxAutoBytes: 100 })
    // Block too big for the budget → fully dropped, not partially included.
    expect(out.blocks).toEqual([])
    expect(out.items[0].status).toBe("skipped")
  })

  it("preserves the original block array order in the result", () => {
    const blocks = [
      block("a", "i1", 100, 5), // input order: a, b, c
      block("b", "i2", 100, 1),
      block("c", "i3", 100, 3),
    ]
    const items = [item("i1", 5, 100), item("i2", 1, 100), item("i3", 3, 100)]
    const out = applyAutoContextBudget(blocks, items, { maxAutoBytes: 500 })
    expect(out.blocks.map((b) => b.id)).toEqual(["a", "b", "c"])
  })
})

describe("readContextSettings", () => {
  it("falls back to defaults when nothing is set", () => {
    const cfg = { get: <T>(_k: string): T | undefined => undefined }
    expect(readContextSettings(cfg)).toEqual(DEFAULT_CONTEXT_SETTINGS)
  })

  it("returns explicit overrides", () => {
    const cfg = {
      get<T>(key: string): T | undefined {
        if (key === "context.enabled") return false as unknown as T
        if (key === "context.maxBytes") return 50000 as unknown as T
        if (key === "context.maxAutoBytes") return 25000 as unknown as T
        if (key === "context.maxMentionBytes") return 10000 as unknown as T
        if (key === "context.showManifest") return false as unknown as T
        return undefined
      },
    }
    expect(readContextSettings(cfg)).toEqual({
      enabled: false,
      maxBytes: 50000,
      maxAutoBytes: 25000,
      maxMentionBytes: 10000,
      showManifest: false,
    })
  })
})
