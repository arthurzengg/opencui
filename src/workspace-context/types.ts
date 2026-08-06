import type { PromptContextManifestItem } from "../protocol"

/**
 * A single chunk of context the host plans to include in the prompt. The
 * builder (`buildPrompt`) splices these into the final string under one
 * `## <title>` heading per block.
 */
export type PromptContextBlock = {
  id: string
  /** Manifest item this block corresponds to — for budget/skip bookkeeping. */
  itemID: string
  title: string
  /** Optional path used by some block renderers (diagnostics, docs). */
  path?: string
  /** Optional language hint for ```<lang> fences. */
  language?: string
  content: string
  bytes: number
  /** Lower priority = higher preference for inclusion when budgets bite. */
  priority: number
}

export type CollectorOutput = {
  items: PromptContextManifestItem[]
  blocks: PromptContextBlock[]
}
