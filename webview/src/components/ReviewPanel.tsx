import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react"
import type { Message } from "../hooks/useChatState"
import type { ReviewChange, ReviewHunkState } from "../protocol"

type DiffHunk = {
  id: string
}

export function ReviewPanel({
  messages,
  selectedPath,
  selectedKey,
  reviewedHunks,
  onSelectPath,
  onOpenReviewChange,
  onReviewAllInChange,
}: {
  messages: Message[]
  selectedPath?: string
  selectedKey?: number
  reviewedHunks: Record<string, ReviewHunkState>
  onSelectPath?: (path: string) => void
  onOpenReviewChange?: (change: ReviewChange) => void
  onReviewAllInChange?: (source: string, path: string, action: ReviewHunkState) => void
}) {
  const changes = useMemo(() => turnChanges(messages), [messages])
  const pendingChanges = useMemo(
    () => changes.map((change) => ({ change, diff: splitDiff(change.patch) }))
      .filter(({ change, diff }) => (
        isTextReviewChange(change) && diff.hunks.some((hunk) => !reviewedHunks[reviewKey(change, hunk.id)])
      )),
    [changes, reviewedHunks],
  )
  const [open, setOpen] = useState(true)
  const [internalSelectedPath, setInternalSelectedPath] = useState<string>()

  useEffect(() => {
    if (!selectedPath) return
    setInternalSelectedPath(selectedPath)
    setOpen(true)
  }, [selectedPath, selectedKey])

  if (!pendingChanges.length) return null

  const activePath = selectedPath ?? internalSelectedPath
  const selected = pendingChanges.find(({ change }) => samePath(change.path, activePath))?.change ?? pendingChanges[0].change
  const additions = pendingChanges.reduce((total, { change }) => total + change.additions, 0)
  const deletions = pendingChanges.reduce((total, { change }) => total + change.deletions, 0)
  const displayNames = disambiguatePaths(pendingChanges.map(({ change }) => change.path))
  const selectChange = (change: ReviewChange) => {
    setInternalSelectedPath(change.path)
    onSelectPath?.(change.path)
    onOpenReviewChange?.(change)
  }

  const isSingle = pendingChanges.length === 1
  const onlyChange = isSingle ? pendingChanges[0].change : undefined

  return (
    <div className={`review-panel ${open ? "" : "is-collapsed"}`}>
      <button className="review-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`review-caret ${open ? "is-open" : ""}`}>›</span>
        <span className="review-title">{isSingle ? "Review" : "Review changes"}</span>
        <span className="review-summary" title={onlyChange?.path}>
          {onlyChange ? (displayNames.get(onlyChange.path) ?? basename(onlyChange.path)) : `${pendingChanges.length} files`}
        </span>
        <span className="review-stat add">+{additions}</span>
        <span className="review-stat del">-{deletions}</span>
      </button>
      <div className="review-body-clip" aria-hidden={!open}>
        <div className="review-body">
          <div className="review-files">
            {pendingChanges.map(({ change }) => {
              const isSelected = change.source === selected.source && change.path === selected.path
              const stop = (event: MouseEvent | KeyboardEvent) => event.stopPropagation()
              const act = (action: ReviewHunkState) => {
                onReviewAllInChange?.(change.source, change.path, action)
              }
              return (
                <div
                  key={`${change.source}:${change.path}`}
                  className={`review-file kind-${change.kind} ${isSelected ? "is-selected" : ""}`}
                  onClick={() => selectChange(change)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      selectChange(change)
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  title={change.path}
                >
                  <span className="review-file-name">{displayNames.get(change.path) ?? basename(change.path)}</span>
                  <span className="review-file-stat add">+{change.additions}</span>
                  <span className="review-file-stat del">-{change.deletions}</span>
                  <button
                    className="review-file-action accept"
                    onClick={(event) => { stop(event); act("accepted") }}
                    onKeyDown={stop}
                    aria-label={`Keep changes in ${basename(change.path)}`}
                    title="Keep all changes in this file"
                  >
                    Keep
                  </button>
                  <button
                    className="review-file-action reject"
                    onClick={(event) => { stop(event); act("rejected") }}
                    onKeyDown={stop}
                    aria-label={`Undo changes in ${basename(change.path)}`}
                    title="Undo all changes in this file"
                  >
                    Undo
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

export function disambiguatePaths(paths: string[]): Map<string, string> {
  const result = new Map<string, string>()
  const groups = new Map<string, string[]>()
  for (const path of paths) {
    const key = basename(path)
    const list = groups.get(key) ?? []
    list.push(path)
    groups.set(key, list)
  }
  for (const [, group] of groups) {
    if (group.length === 1) {
      result.set(group[0]!, basename(group[0]!))
      continue
    }
    for (const path of group) {
      result.set(path, shortestUniqueSuffix(path, group))
    }
  }
  return result
}

export function shortestUniqueSuffix(target: string, group: string[]): string {
  const targetSegs = target.split(/[\\/]/).filter(Boolean)
  for (let depth = 1; depth <= targetSegs.length; depth++) {
    const candidate = targetSegs.slice(-depth).join("/")
    const collides = group.some((other) => {
      if (other === target) return false
      const otherSegs = other.split(/[\\/]/).filter(Boolean)
      return otherSegs.slice(-depth).join("/") === candidate
    })
    if (!collides) return candidate
  }
  return target
}

export function turnChanges(messages: Message[]) {
  const changes = messages.flatMap((message) =>
    message.blocks.flatMap((block, blockIndex) => {
      const source = `${message.id}:${blockIndex}`
      if (block.type === "patch" && block.diff) return diffChanges(block.diff, source)
      if (block.type !== "tool" || block.update.status !== "completed") return []
      return toolChanges(block.update, block.update.callID || source)
    }),
  )
  // When the same file is modified multiple times in the same conversation,
  // collapse the rows so only one appears per file — but SUM additions and
  // deletions across all changes so the row reflects the total work, not
  // just the last edit. Keep the earliest `kind` (so a file that was created
  // and later updated still shows as "created"), and keep the most-recent
  // `source` and `patch` since those drive Action targeting and the popup
  // review-panel diff view. The host's `handleReviewAllInChange` already
  // iterates all matching records by path, so Keep/Undo correctly act on
  // every underlying change.
  return changes.reduce<ReviewChange[]>((acc, change) => {
    const existing = acc.findIndex((item) => samePath(item.path, change.path))
    if (existing < 0) return [...acc, change]
    const prev = acc[existing]!
    const copy = acc.slice()
    copy[existing] = {
      ...change,
      additions: prev.additions + change.additions,
      deletions: prev.deletions + change.deletions,
      kind: prev.kind === "created" || prev.kind === "deleted" ? prev.kind : change.kind,
    }
    return copy
  }, [])
}

export function toolChanges(update: { tool: string; title?: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> }, source: string) {
  if (update.tool === "apply_patch") return patchChanges(update.metadata?.files, source)
  const filediff = isRecord(update.metadata?.filediff) ? update.metadata.filediff : undefined
  let patch = typeof filediff?.patch === "string" ? filediff.patch : typeof update.metadata?.diff === "string" ? update.metadata.diff : undefined
  const isCreate =
    (update.tool === "write" && update.metadata?.exists === false) ||
    (update.tool === "edit" && update.input?.oldString === "")
  // For created files, opencode often doesn't produce a unified diff in
  // metadata since there's nothing to diff against. Synthesize one from the
  // tool's input content so the file shows up in the review card.
  if (!patch && isCreate) patch = synthesizeCreatePatch(update)
  if (!patch) return []
  return [{
    source,
    path: displayPath(update, filediff),
    kind: isCreate ? "created" : "updated",
    additions: typeof filediff?.additions === "number" ? filediff.additions : countDiff(patch, "+"),
    deletions: typeof filediff?.deletions === "number" ? filediff.deletions : countDiff(patch, "-"),
    patch,
  } satisfies ReviewChange]
}

export function synthesizeCreatePatch(update: { tool: string; input?: Record<string, unknown> }): string | undefined {
  const content =
    update.tool === "write" && typeof update.input?.content === "string"
      ? update.input.content
      : update.tool === "edit" && typeof update.input?.newString === "string"
        ? update.input.newString
        : undefined
  if (typeof content !== "string" || content === "") return undefined
  const lines = content.split("\n")
  // git omits a trailing empty line if the content ends in "\n"; mirror that
  // so additions counts match what diff/patch consumers expect.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  if (!lines.length) return undefined
  const body = lines.map((line) => `+${line}`).join("\n")
  return `@@ -0,0 +1,${lines.length} @@\n${body}`
}

export function patchChanges(files: unknown, source: string) {
  if (!Array.isArray(files)) return []
  return files.flatMap((file) => {
    if (!isRecord(file) || typeof file.relativePath !== "string" || typeof file.patch !== "string") return []
    return [{
      source: `${source}:${file.relativePath}`,
      path: file.relativePath,
      kind: patchKind(file.type),
      additions: typeof file.additions === "number" ? file.additions : countDiff(file.patch, "+"),
      deletions: typeof file.deletions === "number" ? file.deletions : countDiff(file.patch, "-"),
      patch: file.patch,
    } satisfies ReviewChange]
  })
}

export function diffChanges(diff: string, source: string) {
  const starts = diff.split("\n").reduce<number[]>((acc, line, index) => (
    line.startsWith("diff --git ") ? [...acc, index] : acc
  ), [])
  if (!starts.length) return createPatchChange(diff, source)
  const lines = diff.split("\n")
  return starts.map((start, index) => {
    const chunk = lines.slice(start, starts[index + 1] ?? lines.length).join("\n")
    const header = lines[start] ?? ""
    const match = header.match(/^diff --git a\/(.+) b\/(.+)$/)
    const path = match?.[2] ?? match?.[1] ?? patchPath(chunk)
    return {
      source: `${source}:${index}`,
      path,
      kind: chunk.includes("\nnew file mode ") ? "created" : chunk.includes("\ndeleted file mode ") ? "deleted" : "updated",
      additions: countDiff(chunk, "+"),
      deletions: countDiff(chunk, "-"),
      patch: chunk,
    } satisfies ReviewChange
  })
}

export function createPatchChange(patch: string, source: string) {
  return [{
    source,
    path: patchPath(patch),
    kind: patch.includes("\n--- /dev/null") ? "created" : patch.includes("\n+++ /dev/null") ? "deleted" : "updated",
    additions: countDiff(patch, "+"),
    deletions: countDiff(patch, "-"),
    patch,
  } satisfies ReviewChange]
}

export function patchPath(patch: string) {
  const plus = patch.match(/\n\+\+\+\s+(?:b\/)?(.+)/)?.[1]
  if (plus && plus !== "/dev/null") return plus
  const minus = patch.match(/\n---\s+(?:a\/)?(.+)/)?.[1]
  if (minus && minus !== "/dev/null") return minus
  const index = patch.match(/^Index:\s+(.+)$/m)?.[1]
  return index ?? "file"
}

export function displayPath(update: { title?: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> }, filediff?: Record<string, unknown>) {
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

export function isAbsolutePath(value: string) {
  // Posix and Windows absolute paths. We don't import node:path in the webview.
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")
}

export function patchKind(value: unknown): ReviewChange["kind"] {
  if (value === "add") return "created"
  if (value === "delete") return "deleted"
  if (value === "move") return "moved"
  return "updated"
}

export function splitDiff(patch: string): { hunks: DiffHunk[] } {
  const lines = patch.split("\n")
  const hunks: DiffHunk[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (!line.startsWith("@@")) {
      index += 1
      continue
    }

    const hunkHeader = line
    index += 1
    while (index < lines.length && !(lines[index] ?? "").startsWith("@@")) {
      index += 1
    }

    hunks.push({
      id: `${hunks.length}-${hunkHeader}`,
    })
  }

  if (!hunks.length && patch.trim()) {
    hunks.push({ id: "0-file" })
  }

  return { hunks }
}

export function reviewKey(change: ReviewChange, hunkID: string) {
  return `${change.source}:${normalizePath(change.path)}:${hunkID}`
}

export function samePath(left: string, right?: string) {
  if (!right) return false
  return normalizePath(left) === normalizePath(right)
}

export function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "")
}

export function isTextReviewChange(change: ReviewChange) {
  if (change.additions === 0 && change.deletions === 0) return false
  const name = basename(change.path).toLowerCase()
  if (!name || name === ".ds_store" || name === "thumbs.db") return false
  const ext = name.includes(".") ? `.${name.split(".").at(-1)}` : ""
  if (!ext && name.startsWith(".")) return false
  return !new Set([
    ".ai",
    ".avif",
    ".bin",
    ".bmp",
    ".class",
    ".db",
    ".dmg",
    ".doc",
    ".docx",
    ".ds_store",
    ".eot",
    ".exe",
    ".gif",
    ".heic",
    ".icns",
    ".ico",
    ".jar",
    ".jpeg",
    ".jpg",
    ".mov",
    ".mp3",
    ".mp4",
    ".otf",
    ".pdf",
    ".png",
    ".pyc",
    ".so",
    ".sqlite",
    ".ttf",
    ".webp",
    ".woff",
    ".woff2",
    ".zip",
  ]).has(ext)
}

export function countDiff(patch: string, prefix: "+" | "-") {
  return patch.split("\n").filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)).length
}

export function basename(value: string) {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
