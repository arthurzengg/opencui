import type { PromptContextManifestItem } from "../protocol"
import type { PromptContextBlock } from "./types"

export type BudgetOptions = {
  /** Cap on the sum of `block.bytes` for automatic-context blocks. */
  maxAutoBytes: number
}

export type AppliedBudget = {
  blocks: PromptContextBlock[]
  items: PromptContextManifestItem[]
  droppedBytes: number
}

/**
 * Trim automatic-context blocks down to `maxAutoBytes`. Lowest-priority-number
 * (= most important) blocks stay; we drop from the high-priority tail until
 * the total fits. Items whose blocks were dropped flip to status `skipped`
 * with an explanatory reason; items without a corresponding block (manifest
 * summaries) pass through untouched.
 *
 * The cap is intentionally a **soft** budget: collectors self-cap already, so
 * this routine is the final guardrail — it doesn't try to slice individual
 * blocks because doing so destroys diff and symbol-table structure. Phase 4's
 * design accepts that "skip an entire block" is easier to explain in the
 * manifest than "truncated to N bytes mid-block".
 */
export function applyAutoContextBudget(
  blocks: PromptContextBlock[],
  items: PromptContextManifestItem[],
  options: BudgetOptions,
): AppliedBudget {
  const { maxAutoBytes } = options
  const sorted = [...blocks].sort((a, b) => a.priority - b.priority)
  const kept: PromptContextBlock[] = []
  const droppedIds = new Set<string>()
  let used = 0
  for (const block of sorted) {
    if (used + block.bytes <= maxAutoBytes) {
      kept.push(block)
      used += block.bytes
    } else {
      droppedIds.add(block.itemID)
    }
  }
  // Preserve the original block order for prompt rendering (buildPrompt
  // re-sorts by priority anyway, but we keep determinism here).
  const keptIds = new Set(kept.map((b) => b.id))
  const orderedKept = blocks.filter((b) => keptIds.has(b.id))
  const updatedItems = items.map((item) => {
    if (!droppedIds.has(item.id)) return item
    return {
      ...item,
      status: "skipped" as const,
      reason: `Skipped: over per-prompt auto-context budget (${maxAutoBytes} bytes)`,
    }
  })
  const droppedBytes = blocks.reduce((acc, b) => acc + b.bytes, 0) - used
  return { blocks: orderedKept, items: updatedItems, droppedBytes }
}

export type ContextSettings = {
  enabled: boolean
  maxBytes: number
  maxAutoBytes: number
  maxMentionBytes: number
  showManifest: boolean
}

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  enabled: true,
  maxBytes: 300_000,
  maxAutoBytes: 120_000,
  maxMentionBytes: 200_000,
  showManifest: true,
}

export function readContextSettings(
  config: { get<T>(key: string): T | undefined },
): ContextSettings {
  return {
    enabled: config.get<boolean>("context.enabled") ?? DEFAULT_CONTEXT_SETTINGS.enabled,
    maxBytes: config.get<number>("context.maxBytes") ?? DEFAULT_CONTEXT_SETTINGS.maxBytes,
    maxAutoBytes:
      config.get<number>("context.maxAutoBytes") ?? DEFAULT_CONTEXT_SETTINGS.maxAutoBytes,
    maxMentionBytes:
      config.get<number>("context.maxMentionBytes") ?? DEFAULT_CONTEXT_SETTINGS.maxMentionBytes,
    showManifest:
      config.get<boolean>("context.showManifest") ?? DEFAULT_CONTEXT_SETTINGS.showManifest,
  }
}
