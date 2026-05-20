import type { WorkspaceRoot } from "../workspace-root"
import { log } from "../output"
import { collectOpenTabs } from "./open-tabs"
import { collectDiagnostics } from "./diagnostics"
import { collectGitDiff } from "./git"
import { RecentEditsTracker } from "./recent-edits"
import { collectDocs } from "./docs"
import { collectSymbols } from "./symbols"
import type { CollectorOutput } from "./types"
import { applyAutoContextBudget } from "./budget"

export type AutoContext = CollectorOutput

export type CollectInputs = {
  workspace: WorkspaceRoot
  recentEdits: RecentEditsTracker
  /** Paths to query for symbol outlines: active editor + mentions. */
  symbolFocus: string[]
  enabled: boolean
  maxAutoBytes: number
}

/**
 * Run every workspace-bound automatic collector in parallel, merge their
 * items + blocks. Collectors are independent and failure-isolated — if one
 * throws, the others still contribute and we log the failure.
 *
 * Phase 4 will wrap this with a budget pass that drops blocks until the
 * total fits a configured cap.
 */
export async function collectAutoContext(input: CollectInputs): Promise<AutoContext> {
  if (!input.enabled) return { items: [], blocks: [] }
  const settled = await Promise.allSettled([
    Promise.resolve(collectDiagnostics(input.workspace)),
    collectOpenTabs(input.workspace),
    collectGitDiff(input.workspace),
    input.recentEdits.collect(input.workspace),
    collectDocs(input.workspace),
    collectSymbols(input.workspace, input.symbolFocus),
  ])
  const items: AutoContext["items"] = []
  const blocks: AutoContext["blocks"] = []
  for (const r of settled) {
    if (r.status === "fulfilled") {
      items.push(...r.value.items)
      blocks.push(...r.value.blocks)
    } else {
      log("auto context: collector failed", r.reason)
    }
  }
  const budgeted = applyAutoContextBudget(blocks, items, { maxAutoBytes: input.maxAutoBytes })
  if (budgeted.droppedBytes > 0) {
    log("auto context: dropped", budgeted.droppedBytes, "bytes over budget", input.maxAutoBytes)
  }
  return { items: budgeted.items, blocks: budgeted.blocks }
}
