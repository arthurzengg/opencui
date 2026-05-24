/**
 * Host-side wrapper for the shared review extraction logic. The actual rules
 * live in `webview/src/review-extract.ts` so host and webview agree on what
 * "the set of changes in this turn" is — having one side collapse differently
 * was previously a source of stale review-card rows.
 */
import type { ChatMessage, ReviewChange, ToolUpdate as WireToolUpdate } from "../protocol"
import {
  displayPath,
  patchChanges,
  patchKind,
  patchPath,
  synthesizeCreatePatch,
  toolChanges as sharedToolChanges,
  turnChanges,
} from "../../webview/src/review-extract"

export function reviewChanges(messages: ChatMessage[]): ReviewChange[] {
  return turnChanges(messages)
}

// Adapter so legacy callers / tests can still pass an SDK ToolUpdate and an
// optional actor through. The shared helper signature is identical to the
// old export's first two parameters.
export function toolChanges(update: WireToolUpdate, source: string): ReviewChange[] {
  return sharedToolChanges(update, source)
}

export {
  displayPath,
  patchChanges,
  patchKind,
  patchPath,
  synthesizeCreatePatch,
}
