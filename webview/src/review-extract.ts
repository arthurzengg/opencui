/**
 * Shared change-extraction + aggregation used by the host (src/chat/review-changes.ts)
 * and the webview Review Panel (components/ReviewPanel.tsx). Both must agree on
 * which file changes a turn contains, otherwise host actions (Keep/Undo all by
 * path) and webview rendering can drift — e.g. the webview would hide a row the
 * host still considers pending, or vice versa.
 *
 * No vscode / node imports here so this works in the webview's jsdom context.
 */
import type { ChatMessage, ReviewChange, ReviewChangeActor, ToolUpdate } from "./protocol"

export type ToolUpdateLike = {
  callID?: string
  tool: string
  status?: string
  title?: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

const BINARY_EXTS = new Set([
  ".ai", ".avif", ".bin", ".bmp", ".class", ".db", ".dmg", ".doc", ".docx",
  ".ds_store", ".eot", ".exe", ".gif", ".heic", ".icns", ".ico", ".jar",
  ".jpeg", ".jpg", ".mov", ".mp3", ".mp4", ".otf", ".pdf", ".png", ".pyc",
  ".so", ".sqlite", ".ttf", ".webp", ".woff", ".woff2", ".zip",
])

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function basename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "")
}

export function samePath(left: string, right?: string): boolean {
  if (!right) return false
  return normalizePath(left) === normalizePath(right)
}

export function isTextReviewChange(change: ReviewChange): boolean {
  if (change.additions === 0 && change.deletions === 0 && change.kind !== "deleted") return false
  return isTextReviewPathName(change.path)
}

export function isTextReviewPathName(value: string): boolean {
  const name = basename(value).toLowerCase()
  if (!name || name === ".ds_store" || name === "thumbs.db") return false
  const ext = name.includes(".") ? `.${name.split(".").at(-1)}` : ""
  if (!ext && name.startsWith(".")) return false
  return !BINARY_EXTS.has(ext)
}

export function countDiff(patch: string, prefix: "+" | "-"): number {
  return patch.split("\n").filter((line) => (
    line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)
  )).length
}

export function patchKind(value: unknown): ReviewChange["kind"] {
  if (value === "add") return "created"
  if (value === "delete") return "deleted"
  if (value === "move") return "moved"
  return "updated"
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")
}

export function displayPath(
  update: { title?: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> },
  filediff?: Record<string, unknown>,
): string {
  // The absolute filepath opencode resolved is unambiguous; prefer it. The
  // model's raw input.filePath can be relative to opencode's internal
  // directory (e.g., the git worktree root) which differs from our VSCode
  // workspace folder, and persisted conversations may already have the wrong
  // relative there.
  const fromMetadata = typeof update.metadata?.filepath === "string" ? update.metadata.filepath : undefined
  if (fromMetadata && isAbsolutePath(fromMetadata)) return fromMetadata
  const fromFilediff = typeof filediff?.file === "string" ? filediff.file : undefined
  if (fromFilediff && isAbsolutePath(fromFilediff)) return fromFilediff
  if (typeof update.input?.filePath === "string" && update.input.filePath) return update.input.filePath
  if (typeof update.title === "string" && update.title.trim()) return update.title
  return fromFilediff ?? "file"
}

export function patchPath(patch: string): string {
  const plus = patch.match(/(?:^|\n)\+\+\+\s+(?:b\/)?(.+)/)?.[1]
  if (plus && plus !== "/dev/null") return plus
  const minus = patch.match(/(?:^|\n)---\s+(?:a\/)?(.+)/)?.[1]
  if (minus && minus !== "/dev/null") return minus
  const index = patch.match(/^Index:\s+(.+)$/m)?.[1]
  return index ?? "file"
}

export function synthesizeCreatePatch(update: ToolUpdateLike): string | undefined {
  const content =
    update.tool === "write" && typeof update.input?.content === "string"
      ? update.input.content
      : update.tool === "edit" && typeof update.input?.newString === "string"
        ? update.input.newString
        : undefined
  if (typeof content !== "string" || content === "") return undefined
  const lines = content.split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  if (!lines.length) return undefined
  const body = lines.map((line) => `+${line}`).join("\n")
  return `@@ -0,0 +1,${lines.length} @@\n${body}`
}

/**
 * Build review changes from one tool update. Used by both host and webview;
 * pass the actor (parent vs subagent) so attribution propagates from the
 * dispatching site. Callers without attribution context may pass undefined
 * — `aggregateChanges` will treat missing actor as `main`.
 */
export function toolChanges(
  update: ToolUpdateLike,
  source: string,
  actor?: ReviewChangeActor,
): ReviewChange[] {
  if (update.status && update.status !== "completed") return []
  if (update.tool === "apply_patch") {
    return patchChanges(update.metadata?.files, source, actor)
  }
  const filediff = isRecord(update.metadata?.filediff) ? update.metadata.filediff : undefined
  let patch =
    typeof filediff?.patch === "string"
      ? filediff.patch
      : typeof update.metadata?.diff === "string"
        ? update.metadata.diff
        : undefined
  const isCreate =
    (update.tool === "write" && update.metadata?.exists === false) ||
    (update.tool === "edit" && update.input?.oldString === "")
  if (!patch && isCreate) patch = synthesizeCreatePatch(update)
  if (!patch) return []
  return [{
    source,
    path: displayPath(update, filediff),
    kind: isCreate ? "created" : "updated",
    additions: typeof filediff?.additions === "number" ? filediff.additions : countDiff(patch, "+"),
    deletions: typeof filediff?.deletions === "number" ? filediff.deletions : countDiff(patch, "-"),
    patch,
    actors: actor ? [actor] : undefined,
  } satisfies ReviewChange]
}

export function patchChanges(
  files: unknown,
  source: string,
  actor?: ReviewChangeActor,
): ReviewChange[] {
  if (!Array.isArray(files)) return []
  return files.flatMap((file) => {
    if (!isRecord(file) || typeof file.relativePath !== "string" || typeof file.patch !== "string") return []
    const kind = patchKind(file.type)
    const oldPath = typeof file.oldPath === "string"
      ? file.oldPath
      : typeof file.fromPath === "string"
        ? file.fromPath
        : undefined
    return [{
      source: `${source}:${file.relativePath}`,
      path: file.relativePath,
      kind,
      additions: typeof file.additions === "number" ? file.additions : countDiff(file.patch, "+"),
      deletions: typeof file.deletions === "number" ? file.deletions : countDiff(file.patch, "-"),
      patch: file.patch,
      oldPath: kind === "moved" ? oldPath : undefined,
      actors: actor ? [actor] : undefined,
    } satisfies ReviewChange]
  })
}

export function diffChanges(
  diff: string,
  source: string,
  actor?: ReviewChangeActor,
): ReviewChange[] {
  const lines = diff.split("\n")
  const starts = lines.reduce<number[]>((acc, line, index) => (
    line.startsWith("diff --git ") ? [...acc, index] : acc
  ), [])
  if (!starts.length) return createPatchChange(diff, source, actor)
  return starts.map((start, index) => {
    const chunk = lines.slice(start, starts[index + 1] ?? lines.length).join("\n")
    const header = lines[start] ?? ""
    const match = header.match(/^diff --git a\/(.+) b\/(.+)$/)
    const pathValue = match?.[2] ?? match?.[1] ?? patchPath(chunk)
    const oldPath = match?.[1] !== match?.[2] ? match?.[1] : undefined
    return {
      source: `${source}:${index}`,
      path: pathValue,
      kind: chunk.includes("\nnew file mode ")
        ? "created"
        : chunk.includes("\ndeleted file mode ")
          ? "deleted"
          : chunk.includes("\nrename to ") || (oldPath && oldPath !== pathValue)
            ? "moved"
            : "updated",
      additions: countDiff(chunk, "+"),
      deletions: countDiff(chunk, "-"),
      patch: chunk,
      oldPath: chunk.includes("\nrename to ") || (oldPath && oldPath !== pathValue) ? oldPath : undefined,
      actors: actor ? [actor] : undefined,
    } satisfies ReviewChange
  })
}

export function createPatchChange(
  patch: string,
  source: string,
  actor?: ReviewChangeActor,
): ReviewChange[] {
  return [{
    source,
    path: patchPath(patch),
    kind: patch.includes("\n--- /dev/null")
      ? "created"
      : patch.includes("\n+++ /dev/null")
        ? "deleted"
        : "updated",
    additions: countDiff(patch, "+"),
    deletions: countDiff(patch, "-"),
    patch,
    actors: actor ? [actor] : undefined,
  } satisfies ReviewChange]
}

function blockActor(block: { actor?: ReviewChangeActor }): ReviewChangeActor {
  // Default to `main` so legacy ChatBlocks without `actor` (persisted before
  // attribution landed) classify correctly. The aggregator drops a single
  // bare `main` actor on display, so this is invisible to existing UI.
  return block.actor ?? { kind: "main" }
}

/**
 * Walk a turn's message list and emit one ReviewChange per logical file edit.
 * Multiple records for the same path are PRESERVED at this stage; collapse
 * them with `aggregateChanges` if you want a per-file row.
 */
export function extractChanges(messages: ChatMessage[]): ReviewChange[] {
  return messages.flatMap((message) =>
    message.blocks.flatMap((block, blockIndex) => {
      const source = `${message.id}:${blockIndex}`
      if (block.type === "patch" && block.diff) {
        return diffChanges(block.diff, source, blockActor(block))
      }
      if (block.type === "tool") {
        if (block.update.status !== "completed") return []
        const callSource = block.update.callID || source
        return toolChanges(block.update, callSource, blockActor(block))
      }
      return [] as ReviewChange[]
    }),
  )
}

/**
 * Collapse multiple ReviewChange records for the same file into one row.
 * - additions / deletions are SUMMED across all changes
 * - `kind` prefers "created" / "deleted" / "moved" over "updated" since
 *   create-then-modify still shows as a creation row
 * - `actors` is merged (deduped) so the row carries every contributor
 * - `source` and `patch` are taken from the MOST RECENT change so the
 *   webview's selected-diff preview shows the latest edit
 * - `oldPath` (move) propagates through if any contributing record had it
 */
export function aggregateChanges(changes: ReviewChange[]): ReviewChange[] {
  return changes.reduce<ReviewChange[]>((acc, change) => {
    const existingIndex = acc.findIndex((item) => samePath(item.path, change.path))
    if (existingIndex < 0) {
      return [...acc, { ...change, actors: dedupActors(change.actors) }]
    }
    const prev = acc[existingIndex]!
    const merged: ReviewChange = {
      ...change,
      additions: prev.additions + change.additions,
      deletions: prev.deletions + change.deletions,
      kind: priorityKind(prev.kind, change.kind),
      oldPath: prev.oldPath ?? change.oldPath,
      actors: dedupActors([...(prev.actors ?? []), ...(change.actors ?? [])]),
    }
    const copy = acc.slice()
    copy[existingIndex] = merged
    return copy
  }, [])
}

function priorityKind(prev: ReviewChange["kind"], next: ReviewChange["kind"]): ReviewChange["kind"] {
  // "created" / "deleted" / "moved" are sticky — a follow-up plain update
  // shouldn't downgrade the row's headline kind. If both are sticky and
  // they conflict (e.g. created then deleted), prefer the later one since
  // that's what the user actually needs to see in the panel.
  if (prev === "updated") return next
  if (next === "updated") return prev
  return next
}

function dedupActors(actors: ReviewChangeActor[] | undefined): ReviewChangeActor[] | undefined {
  if (!actors || !actors.length) return undefined
  const seen = new Map<string, ReviewChangeActor>()
  for (const actor of actors) {
    const key = `${actor.kind}|${actor.sessionID ?? ""}|${actor.subagent ?? ""}`
    if (!seen.has(key)) seen.set(key, actor)
  }
  return [...seen.values()]
}

/**
 * The canonical "what does this turn contain?" function. Used by:
 *  - webview ReviewPanel to render the review card
 *  - host syncReviewDecorations / handleReviewAllInChange to drive actions
 *
 * Both sides MUST produce the same list — keep this the only place that
 * collapses multiple records for the same path.
 */
export function turnChanges(messages: ChatMessage[]): ReviewChange[] {
  return aggregateChanges(extractChanges(messages))
}

/**
 * Compose a stable per-hunk key. Used by both sides to look up
 * `reviewHunks[key]` and decide what's pending. MUST stay the same on host
 * and webview.
 */
export function reviewKey(change: ReviewChange, hunkID: string): string {
  return `${change.source}:${normalizePath(change.path)}:${hunkID}`
}

/** Re-export the protocol type so consumers only need this one import. */
export type { ReviewChange, ReviewChangeActor, ToolUpdate }
