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
 * Apply Keep / Undo for a single path. The two actions walk different record
 * sets on purpose:
 *
 * Undo iterates EVERY per-tool record, newest first: aggregateChanges keeps
 * only the last record's `patch`, so undoing the aggregated row alone would
 * silently skip every earlier tool call's hunks, and only newest-first
 * iteration leaves each record's `newText` anchor matchable when records
 * layered edits on the same lines (A: orig → rev1, B: rev1 → final).
 *
 * Keep verifies ONLY the newest record: it mutates nothing, and once a later
 * tool call touched the file again, earlier records describe intermediate
 * states that by definition no longer exist — verifying them against the
 * final file reported the agent's own follow-up edits as "file has changed"
 * conflicts (#508). Hunks are marked accepted per-result, so a genuinely
 * drifted hunk stays pending instead of being swept up by a wholesale mark.
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
  if (action === "accepted") {
    return acceptNewestRecord(records[records.length - 1]!, aggregated, runner, options)
  }
  const ordered = records.slice().reverse()
  let applied = 0
  let conflicts = 0
  for (const record of ordered) {
    const parsed = splitReviewDiff(record.patch).hunks
    // Create / delete / move revert the file as a unit, so one runner call
    // covers the whole record and only its first hunk is ever attempted.
    // Slicing up front rather than tracking "have we called the runner yet" is
    // what makes an unreversible first hunk consume that single attempt: while
    // the guard keyed off a flag set only AFTER a successful call, an
    // unparseable first `@@` left the slot open and hunk 2 ran too — for a
    // `deleted` record that had `undoDelete` restore the file from a partial
    // fragment of its content and report success.
    const hunks = record.kind === "updated" ? parsed : parsed.slice(0, 1)
    for (const hunk of hunks) {
      if (!hunk.reversible) {
        conflicts += 1
        continue
      }
      const outcome = await runner(record, hunk, action, { silent: true, root: options.root })
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

/**
 * The newest record's kind (not the aggregated row's sticky kind) picks the
 * check: a create-then-edit turn aggregates as "created", but the final state
 * on disk is the edit's, and the text verification is the stronger claim.
 * Hunk keys are computed against the aggregated row because that is what the
 * panel and reviewedKeys are keyed on — the ids line up since aggregateChanges
 * takes the aggregated `patch` from this same newest record.
 */
async function acceptNewestRecord(
  newest: ReviewChange,
  aggregated: ReviewChange,
  runner: ReviewHunkRunner,
  options: ReviewAllForPathOptions,
): Promise<ReviewAllForPathResult> {
  const parsed = splitReviewDiff(newest.patch).hunks
  const hunkUpdates: HunkUpdate[] = []
  // Create / delete / move verify the file as a unit: one runner call, and
  // success settles every hunk of the row.
  if (newest.kind !== "updated") {
    const hunk = parsed[0]
    if (!hunk) return { applied: 0, conflicts: 0, hunkUpdates }
    const outcome = await runner(newest, hunk, "accepted", { silent: true, root: options.root })
    if (outcome.status !== "applied" && outcome.status !== "no-op") {
      return { applied: 0, conflicts: 1, hunkUpdates }
    }
    for (const key of splitReviewDiff(aggregated.patch).hunks.map((h) => reviewKey(aggregated, h.id))) {
      if (options.reviewedKeys[key]) continue
      hunkUpdates.push({ key, state: "accepted" })
    }
    return { applied: 1, conflicts: 0, hunkUpdates }
  }
  let applied = 0
  let conflicts = 0
  for (const hunk of parsed) {
    const key = reviewKey(aggregated, hunk.id)
    if (options.reviewedKeys[key]) continue
    const outcome = await runner(newest, hunk, "accepted", { silent: true, root: options.root })
    if (outcome.status === "applied" || outcome.status === "no-op") {
      applied += 1
      hunkUpdates.push({ key, state: "accepted" })
      continue
    }
    conflicts += 1
  }
  return { applied, conflicts, hunkUpdates }
}
