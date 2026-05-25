import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react"
import type { Message } from "../hooks/useChatState"
import type { ReviewChange, ReviewChangeActor, ReviewHunkState } from "../protocol"
import {
  basename,
  isTextReviewChange,
  normalizePath,
  reviewKey,
  samePath,
  turnChanges,
} from "../review-extract"

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

  const bulkAct = (action: ReviewHunkState) => {
    for (const { change } of pendingChanges) {
      onReviewAllInChange?.(change.source, change.path, action)
    }
  }
  const stopHead = (event: MouseEvent | KeyboardEvent) => event.stopPropagation()

  return (
    <div className={`review-panel ${open ? "" : "is-collapsed"}`}>
      <div className="review-head-row">
        <button className="review-head" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={`review-caret ${open ? "is-open" : ""}`}>›</span>
          <span className="review-title">{isSingle ? "Review" : "Review changes"}</span>
          <span className="review-summary" title={onlyChange?.path}>
            {onlyChange ? (displayNames.get(onlyChange.path) ?? basename(onlyChange.path)) : `${pendingChanges.length} files`}
          </span>
          <span className="review-stat add">+{additions}</span>
          <span className="review-stat del">-{deletions}</span>
        </button>
        {!isSingle && (
          <div className="review-bulk-actions">
            <button
              className="review-bulk-action accept"
              onClick={(event) => { stopHead(event); bulkAct("accepted") }}
              onKeyDown={stopHead}
              title={`Keep changes in all ${pendingChanges.length} files`}
              aria-label="Keep all changes"
            >
              Keep all
            </button>
            <button
              className="review-bulk-action reject"
              onClick={(event) => { stopHead(event); bulkAct("rejected") }}
              onKeyDown={stopHead}
              title={`Undo changes in all ${pendingChanges.length} files`}
              aria-label="Undo all changes"
            >
              Undo all
            </button>
          </div>
        )}
      </div>
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
                  title={actorTooltip(change)}
                >
                  <span className="review-file-kind" aria-label={kindLabel(change.kind)}>{kindLetter(change.kind)}</span>
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

// Mirrors VS Code's SCM badge letters so users familiar with the gutter can
// scan the review card without re-learning a separate convention.
function kindLetter(kind: ReviewChange["kind"]): string {
  switch (kind) {
    case "created": return "U"
    case "updated": return "M"
    case "deleted": return "D"
    case "moved": return "R"
  }
}

function kindLabel(kind: ReviewChange["kind"]): string {
  switch (kind) {
    case "created": return "Untracked"
    case "updated": return "Modified"
    case "deleted": return "Deleted"
    case "moved": return "Renamed"
  }
}

// The Review Card intentionally shows only the filename + stats per row;
// subagent attribution lives on the title tooltip so users can hover to see
// "Modified by: <subagent>" without the row sprouting an extra label.
function actorTooltip(change: ReviewChange): string {
  const subagents = (change.actors ?? [])
    .filter((actor) => actor.kind === "subagent")
    .map((actor) => actor.subagent || actor.sessionID || "subagent")
  if (!subagents.length) return change.path
  return `${change.path}\nModified by: ${subagents.join(", ")}`
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

// Re-export the shared helpers used by tests so existing import paths
// (`from "ReviewPanel"`) keep working.
export {
  basename,
  countDiff,
  isAbsolutePath,
  isTextReviewChange,
  normalizePath,
  patchKind,
  reviewKey,
  samePath,
  synthesizeCreatePatch,
  toolChanges,
  turnChanges,
} from "../review-extract"
export type { ReviewChangeActor }
