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

function disambiguatePaths(paths: string[]): Map<string, string> {
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

function shortestUniqueSuffix(target: string, group: string[]): string {
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

function turnChanges(messages: Message[]) {
  const changes = messages.flatMap((message) =>
    message.blocks.flatMap((block, blockIndex) => {
      const source = `${message.id}:${blockIndex}`
      if (block.type === "patch" && block.diff) return diffChanges(block.diff, source)
      if (block.type !== "tool" || block.update.status !== "completed") return []
      return toolChanges(block.update, block.update.callID || source)
    }),
  )
  return changes.reduce<ReviewChange[]>((acc, change) => {
    const existing = acc.findIndex((item) => samePath(item.path, change.path))
    if (existing < 0) return [...acc, change]
    const copy = acc.slice()
    copy[existing] = change
    return copy
  }, [])
}

function toolChanges(update: { tool: string; title?: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> }, source: string) {
  if (update.tool === "apply_patch") return patchChanges(update.metadata?.files, source)
  const filediff = isRecord(update.metadata?.filediff) ? update.metadata.filediff : undefined
  const patch = typeof filediff?.patch === "string" ? filediff.patch : typeof update.metadata?.diff === "string" ? update.metadata.diff : undefined
  if (!patch) return []
  return [{
    source,
    path: displayPath(update, filediff),
    kind: update.tool === "write" && update.metadata?.exists === false ? "created" : "updated",
    additions: typeof filediff?.additions === "number" ? filediff.additions : countDiff(patch, "+"),
    deletions: typeof filediff?.deletions === "number" ? filediff.deletions : countDiff(patch, "-"),
    patch,
  } satisfies ReviewChange]
}

function patchChanges(files: unknown, source: string) {
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

function diffChanges(diff: string, source: string) {
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

function createPatchChange(patch: string, source: string) {
  return [{
    source,
    path: patchPath(patch),
    kind: patch.includes("\n--- /dev/null") ? "created" : patch.includes("\n+++ /dev/null") ? "deleted" : "updated",
    additions: countDiff(patch, "+"),
    deletions: countDiff(patch, "-"),
    patch,
  } satisfies ReviewChange]
}

function patchPath(patch: string) {
  const plus = patch.match(/\n\+\+\+\s+(?:b\/)?(.+)/)?.[1]
  if (plus && plus !== "/dev/null") return plus
  const minus = patch.match(/\n---\s+(?:a\/)?(.+)/)?.[1]
  if (minus && minus !== "/dev/null") return minus
  const index = patch.match(/^Index:\s+(.+)$/m)?.[1]
  return index ?? "file"
}

function displayPath(update: { title?: string; input?: Record<string, unknown> }, filediff?: Record<string, unknown>) {
  if (typeof update.title === "string" && update.title.trim()) return update.title
  if (typeof update.input?.filePath === "string") return update.input.filePath
  if (typeof filediff?.file === "string") return filediff.file
  return "file"
}

function patchKind(value: unknown): ReviewChange["kind"] {
  if (value === "add") return "created"
  if (value === "delete") return "deleted"
  if (value === "move") return "moved"
  return "updated"
}

function splitDiff(patch: string): { hunks: DiffHunk[] } {
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

function reviewKey(change: ReviewChange, hunkID: string) {
  return `${change.source}:${normalizePath(change.path)}:${hunkID}`
}

function samePath(left: string, right?: string) {
  if (!right) return false
  return normalizePath(left) === normalizePath(right)
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "")
}

function isTextReviewChange(change: ReviewChange) {
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

function countDiff(patch: string, prefix: "+" | "-") {
  return patch.split("\n").filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)).length
}

function basename(value: string) {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
