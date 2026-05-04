import { useEffect, useMemo, useState } from "react"
import type { Message } from "../hooks/useChatState"

type Change = {
  path: string
  kind: "created" | "updated" | "deleted" | "moved"
  additions: number
  deletions: number
  patch: string
}

type ReviewState = "accepted" | "rejected"

type DiffLine = {
  text: string
  kind: "add" | "del" | "hunk" | "ctx"
}

type DiffHunk = {
  id: string
  header: string
  lines: DiffLine[]
  oldText: string
  newText: string
}

export function ReviewPanel({
  messages,
  selectedPath,
  selectedKey,
  onSelectPath,
  onOpenFile,
  onReviewHunk,
}: {
  messages: Message[]
  selectedPath?: string
  selectedKey?: number
  onSelectPath?: (path: string) => void
  onOpenFile?: (path: string) => void
  onReviewHunk?: (path: string, action: "accept" | "reject", oldText: string, newText: string) => void
}) {
  const changes = useMemo(() => turnChanges(messages), [messages])
  const [open, setOpen] = useState(true)
  const [internalSelectedPath, setInternalSelectedPath] = useState<string>()
  const [reviewed, setReviewed] = useState<Record<string, ReviewState>>({})

  useEffect(() => {
    if (!selectedPath) return
    setInternalSelectedPath(selectedPath)
    setOpen(true)
  }, [selectedPath, selectedKey])

  if (!changes.length) return null

  const activePath = selectedPath ?? internalSelectedPath
  const selected = changes.find((change) => samePath(change.path, activePath)) ?? changes[0]
  const additions = changes.reduce((total, change) => total + change.additions, 0)
  const deletions = changes.reduce((total, change) => total + change.deletions, 0)
  const selectPath = (path: string) => {
    setInternalSelectedPath(path)
    onSelectPath?.(path)
    onOpenFile?.(path)
  }
  const diff = selected ? splitDiff(selected.patch) : undefined
  const reviewHunk = (hunk: DiffHunk, action: "accept" | "reject") => {
    setReviewed((current) => ({ ...current, [reviewKey(selected.path, hunk.id)]: action === "accept" ? "accepted" : "rejected" }))
    onReviewHunk?.(selected.path, action, hunk.oldText, hunk.newText)
  }

  return (
    <div className={`review-panel ${open ? "" : "is-collapsed"}`}>
      <button className="review-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`review-caret ${open ? "is-open" : ""}`}>›</span>
        <span className="review-title">Review changes</span>
        <span className="review-summary">
          {changes.length} file{changes.length === 1 ? "" : "s"}
        </span>
        <span className="review-stat add">+{additions}</span>
        <span className="review-stat del">-{deletions}</span>
      </button>
      <div className="review-body-clip" aria-hidden={!open}>
        <div className="review-body">
          <div className="review-files">
            {changes.map((change) => (
              <button
                key={change.path}
                className={`review-file ${change.path === selected.path ? "is-selected" : ""}`}
                onClick={() => selectPath(change.path)}
                title={change.path}
              >
                <span className={`review-badge kind-${change.kind}`}>{kindLetter(change.kind)}</span>
                <span className="review-file-name">{basename(change.path)}</span>
                <span className="review-file-path">{dirname(change.path)}</span>
                <span className="review-file-stat add">+{change.additions}</span>
                <span className="review-file-stat del">-{change.deletions}</span>
              </button>
            ))}
          </div>
          {selected && (
            <div className="review-diff" role="region" aria-label={`Diff for ${selected.path}`}>
              <div className="review-diff-title">{selected.path}</div>
              <div key={selected.path} className="review-diff-content">
                {diff?.header.length ? <DiffLines lines={diff.header} /> : null}
                {diff?.hunks.map((hunk, index) => {
                  const state = reviewed[reviewKey(selected.path, hunk.id)]
                  return (
                    <div key={hunk.id} className={`review-hunk ${state ? `is-${state}` : ""}`}>
                      <div className="review-hunk-head">
                        <span className="review-hunk-title">Hunk {index + 1}</span>
                        {state && <span className="review-hunk-state">{state}</span>}
                        <button className="review-hunk-action accept" disabled={Boolean(state)} onClick={() => reviewHunk(hunk, "accept")}>
                          Accept
                        </button>
                        <button className="review-hunk-action reject" disabled={Boolean(state)} onClick={() => reviewHunk(hunk, "reject")}>
                          Reject
                        </button>
                      </div>
                      <DiffLines lines={[{ text: hunk.header, kind: "hunk" }, ...hunk.lines]} />
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="review-diff-code">
      {lines.map((line, index) => (
        <code key={index} className={`review-diff-line ${line.kind}`}>
          {line.text || " "}
        </code>
      ))}
    </pre>
  )
}

function turnChanges(messages: Message[]) {
  const lastUser = messages.findLastIndex((message) => message.role === "user")
  const scoped = lastUser >= 0 ? messages.slice(lastUser + 1) : messages
  const changes = scoped.flatMap((message) =>
    message.blocks.flatMap((block) => {
      if (block.type === "patch" && block.diff) return diffChanges(block.diff)
      if (block.type !== "tool" || block.update.status !== "completed") return []
      return toolChanges(block.update)
    }),
  )
  return changes.reduce<Change[]>((acc, change) => {
    const existing = acc.findIndex((item) => item.path === change.path)
    if (existing < 0) return [...acc, change]
    const copy = acc.slice()
    copy[existing] = change
    return copy
  }, [])
}

function toolChanges(update: { tool: string; title?: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> }) {
  if (update.tool === "apply_patch") return patchChanges(update.metadata?.files)
  const filediff = isRecord(update.metadata?.filediff) ? update.metadata.filediff : undefined
  const patch = typeof filediff?.patch === "string" ? filediff.patch : typeof update.metadata?.diff === "string" ? update.metadata.diff : undefined
  if (!patch) return []
  return [{
    path: displayPath(update, filediff),
    kind: update.tool === "write" && update.metadata?.exists === false ? "created" : "updated",
    additions: typeof filediff?.additions === "number" ? filediff.additions : countDiff(patch, "+"),
    deletions: typeof filediff?.deletions === "number" ? filediff.deletions : countDiff(patch, "-"),
    patch,
  } satisfies Change]
}

function patchChanges(files: unknown) {
  if (!Array.isArray(files)) return []
  return files.flatMap((file) => {
    if (!isRecord(file) || typeof file.relativePath !== "string" || typeof file.patch !== "string") return []
    return [{
      path: file.relativePath,
      kind: patchKind(file.type),
      additions: typeof file.additions === "number" ? file.additions : countDiff(file.patch, "+"),
      deletions: typeof file.deletions === "number" ? file.deletions : countDiff(file.patch, "-"),
      patch: file.patch,
    } satisfies Change]
  })
}

function diffChanges(diff: string) {
  const starts = diff.split("\n").reduce<number[]>((acc, line, index) => (
    line.startsWith("diff --git ") ? [...acc, index] : acc
  ), [])
  if (!starts.length) return createPatchChange(diff)
  const lines = diff.split("\n")
  return starts.map((start, index) => {
    const chunk = lines.slice(start, starts[index + 1] ?? lines.length).join("\n")
    const header = lines[start] ?? ""
    const match = header.match(/^diff --git a\/(.+) b\/(.+)$/)
    const path = match?.[2] ?? match?.[1] ?? patchPath(chunk)
    return {
      path,
      kind: chunk.includes("\nnew file mode ") ? "created" : chunk.includes("\ndeleted file mode ") ? "deleted" : "updated",
      additions: countDiff(chunk, "+"),
      deletions: countDiff(chunk, "-"),
      patch: chunk,
    } satisfies Change
  })
}

function createPatchChange(patch: string) {
  return [{
    path: patchPath(patch),
    kind: patch.includes("\n--- /dev/null") ? "created" : patch.includes("\n+++ /dev/null") ? "deleted" : "updated",
    additions: countDiff(patch, "+"),
    deletions: countDiff(patch, "-"),
    patch,
  } satisfies Change]
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

function patchKind(value: unknown): Change["kind"] {
  if (value === "add") return "created"
  if (value === "delete") return "deleted"
  if (value === "move") return "moved"
  return "updated"
}

function diffLines(patch: string) {
  return patch.split("\n").map((text) => ({
    text,
    kind: text.startsWith("+") && !text.startsWith("+++") ? "add" : text.startsWith("-") && !text.startsWith("---") ? "del" : text.startsWith("@@") ? "hunk" : "ctx",
  } satisfies DiffLine))
}

function splitDiff(patch: string): { header: DiffLine[]; hunks: DiffHunk[] } {
  const lines = patch.split("\n")
  const header: string[] = []
  const hunks: DiffHunk[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (!line.startsWith("@@")) {
      header.push(line)
      index += 1
      continue
    }

    const hunkHeader = line
    const hunkLines: string[] = []
    index += 1
    while (index < lines.length && !(lines[index] ?? "").startsWith("@@")) {
      hunkLines.push(lines[index] ?? "")
      index += 1
    }

    const { oldText, newText } = hunkText(hunkLines)
    hunks.push({
      id: `${hunks.length}-${hunkHeader}`,
      header: hunkHeader,
      lines: diffLines(hunkLines.join("\n")),
      oldText,
      newText,
    })
  }

  return {
    header: diffLines(header.join("\n")).filter((line) => line.text.trim()),
    hunks,
  }
}

function hunkText(lines: string[]) {
  const oldLines: string[] = []
  const newLines: string[] = []
  for (const line of lines) {
    if (line.startsWith("\\ No newline")) continue
    if (line.startsWith("+") && !line.startsWith("+++")) {
      newLines.push(line.slice(1))
      continue
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      oldLines.push(line.slice(1))
      continue
    }
    const text = line.startsWith(" ") ? line.slice(1) : line
    oldLines.push(text)
    newLines.push(text)
  }
  return {
    oldText: oldLines.join("\n"),
    newText: newLines.join("\n"),
  }
}

function reviewKey(path: string, hunkID: string) {
  return `${normalizePath(path)}:${hunkID}`
}

function samePath(left: string, right?: string) {
  if (!right) return false
  return normalizePath(left) === normalizePath(right)
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "")
}

function countDiff(patch: string, prefix: "+" | "-") {
  return patch.split("\n").filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)).length
}

function kindLetter(kind: Change["kind"]) {
  if (kind === "created") return "A"
  if (kind === "deleted") return "D"
  if (kind === "moved") return "R"
  return "M"
}

function basename(value: string) {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

function dirname(value: string) {
  const parts = value.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 1) return ""
  return parts.slice(0, -1).join("/")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
