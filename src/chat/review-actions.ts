import type { ReviewChange, ReviewHunkState } from "../protocol"
import { reviewHunk as defaultReviewHunk, type ReviewHunkOutcome } from "./fs-ops"
import { splitReviewDiff, type ReviewDiffHunk } from "./diff"
import { reviewKey } from "../../webview/src/review-extract"

export type HunkUpdate = { key: string; state: ReviewHunkState }

export type ReviewAllForPathResult = {
  applied: number
  conflicts: number
  hunkUpdates: HunkUpdate[]
}

export type ReviewHunkRunner = (
  change: ReviewChange,
  hunk: ReviewDiffHunk,
  action: ReviewHunkState,
  options: { silent?: boolean; root?: string },
) => Promise<ReviewHunkOutcome>

export type ReviewAllForPathOptions = {
  root?: string
  reviewedKeys: Record<string, ReviewHunkState>
  runReviewHunk?: ReviewHunkRunner
}

/**
 * Apply Keep / Undo to every per-tool record matching a single path.
 *
 * Why iterate per-tool records instead of the aggregated row: aggregateChanges
 * collapses multiple ReviewChange records into one row by KEEPING ONLY the
 * last contributing record's `patch`. Acting on the aggregated patch alone
 * silently skips every earlier tool call's hunks — a half-undo the user
 * never sees. We act on the un-aggregated extract so every hunk reaches
 * `reviewHunk()`, then key the UI state on the aggregated row so the panel,
 * decorations, and snapshots stay coherent.
 *
 * Reverse order for Undo: when two records edited the same lines (A: orig →
 * rev1, B: rev1 → final), only newest-first iteration leaves each record's
 * `newText` anchor matchable. For non-overlapping edits the order still
 * matters because reverting a downstream hunk first keeps upstream line
 * anchors unshifted.
 */
export async function reviewAllForPath(
  records: ReviewChange[],
  aggregated: ReviewChange | undefined,
  action: ReviewHunkState,
  options: ReviewAllForPathOptions,
): Promise<ReviewAllForPathResult> {
  if (!aggregated || records.length === 0) {
    return { applied: 0, conflicts: 0, hunkUpdates: [] }
  }
  const aggregatedHunks = splitReviewDiff(aggregated.patch).hunks
  const aggregatedKeys = aggregatedHunks.map((hunk) => reviewKey(aggregated, hunk.id))
  if (aggregatedKeys.length > 0 && aggregatedKeys.every((key) => options.reviewedKeys[key])) {
    return { applied: 0, conflicts: 0, hunkUpdates: [] }
  }
  const runner = options.runReviewHunk ?? defaultReviewHunk
  const ordered = action === "rejected" ? records.slice().reverse() : records
  let applied = 0
  let conflicts = 0
  for (const record of ordered) {
    const hunks = splitReviewDiff(record.patch).hunks
    let firstHunk = true
    for (const hunk of hunks) {
      if (action === "rejected" && !hunk.reversible) {
        conflicts += 1
        continue
      }
      if (!firstHunk && record.kind !== "updated") {
        continue
      }
      const outcome = await runner(record, hunk, action, { silent: true, root: options.root })
      firstHunk = false
      if (outcome.status === "applied" || outcome.status === "no-op") {
        applied += 1
        continue
      }
      conflicts += 1
    }
  }
  const hunkUpdates: HunkUpdate[] = []
  if (applied > 0) {
    for (const key of aggregatedKeys) {
      if (options.reviewedKeys[key]) continue
      hunkUpdates.push({ key, state: action })
    }
  }
  return { applied, conflicts, hunkUpdates }
}
