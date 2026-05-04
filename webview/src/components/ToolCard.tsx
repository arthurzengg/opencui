import { useState } from "react"
import type { ToolUpdate } from "../protocol"
import { vscode } from "../vscode"

export function ToolTimeline({ updates, onReviewFile }: { updates: ToolUpdate[]; onReviewFile?: (path: string) => void }) {
  const [open, setOpen] = useState(true)

  return (
    <div className="tool-log">
      <button className="tool-log-head" onClick={() => setOpen(!open)}>
        <span className="tool-log-title">{toolHeadline(updates)}</span>
        <span className={`tool-log-caret ${open ? "is-open" : ""}`}>›</span>
      </button>
      {open && (
        <div className="tool-log-list">
          {updates.map((update) => (
            <ToolRow key={update.callID} update={update} onReviewFile={onReviewFile} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolRow({ update, onReviewFile }: { update: ToolUpdate; onReviewFile?: (path: string) => void }) {
  const item = row(update)
  const openInReview = Boolean(item.filePath && onReviewFile && previewsInReview(update))
  const content = (
    <>
      <span className="tool-log-action">{item.action}</span>
      {item.target && <span className="tool-log-target">{item.target}</span>}
      {item.meta && <span className="tool-log-meta">{item.meta}</span>}
      {update.status === "running" && <span className="tool-log-meta">running</span>}
      {update.status === "error" && <span className="tool-log-error">{update.error ?? "failed"}</span>}
    </>
  )
  if (item.filePath) {
    return (
      <button
        className={`tool-log-row is-clickable status-${update.status}`}
        onClick={() => openInReview ? onReviewFile?.(item.filePath!) : vscode.post({ type: "openFile", path: item.filePath! })}
        title={item.title ?? item.filePath}
      >
        {content}
      </button>
    )
  }
  return <div className={`tool-log-row status-${update.status}`} title={item.title}>{content}</div>
}

export function toolHeadline(updates: ToolUpdate[]) {
  const changes = changedFiles(updates)
  if (changes.length) {
    const created = changes.filter((change) => change.kind === "created").length
    const deleted = changes.filter((change) => change.kind === "deleted").length
    if (changes.length === 1) return `${kindLabel(changes[0]!.kind)} ${basename(changes[0]!.path)}`
    if (created && created === changes.length) return `Created ${created} ${plural(created, "file")}`
    if (deleted && deleted === changes.length) return `Deleted ${deleted} ${plural(deleted, "file")}`
    return `Changed ${changes.length} ${plural(changes.length, "file")}`
  }

  const files = new Set(updates.flatMap((update) => {
    const item = row(update)
    return item.filePath && isFileTool(update.tool) ? [item.filePath] : []
  })).size
  const searches = updates.filter((update) => update.tool === "grep" || update.tool === "glob").length
  if (files && searches) return `Explored ${files} ${plural(files, "file")}, ${searches} ${plural(searches, "search")}`
  if (files) return `Read ${files} ${plural(files, "file")}`
  if (searches) return `Ran ${searches} ${plural(searches, "search")}`
  return `Used ${updates.length} ${plural(updates.length, "tool")}`
}

function row(update: ToolUpdate): { action: string; target?: string; meta?: string; filePath?: string; title?: string } {
  const filePath = pickPath(update)
  const target = filePath ? basename(filePath) : summary(update)
  if (update.tool === "read") return { action: "Read", target, meta: lineRange(update), filePath }
  if (update.tool === "grep") return { action: "Grepped", target }
  if (update.tool === "glob") return { action: "Searched", target: globTarget(update), title: globTitle(update) }
  if (update.tool === "bash") return { action: "Ran", target }
  if (update.tool === "edit") return { action: editKind(update), target, meta: diffStat(update), filePath, title: filePath }
  if (update.tool === "write") return { action: writeKind(update), target, meta: writeMeta(update), filePath, title: filePath }
  if (update.tool === "apply_patch") return { action: "Applied", target: patchTarget(update), meta: patchMeta(update), title: update.output }
  if (update.tool === "webfetch") return { action: "Fetched", target }
  if (update.tool === "todowrite") return { action: "Updated", target: "todos" }
  if (update.tool === "task") return { action: "Investigating", target }
  return { action: pastTense(update.tool), target }
}

function globTarget(update: ToolUpdate) {
  if (typeof update.input?.path === "string" && update.input.path !== "." && update.input.path.trim()) {
    return update.input.path
  }
  if (typeof update.title === "string" && update.title !== "." && update.title.trim()) {
    return update.title
  }
  return "project files"
}

function globTitle(update: ToolUpdate) {
  if (typeof update.input?.pattern !== "string") return undefined
  return `Pattern: ${update.input.pattern}`
}

function summary(update: ToolUpdate): string | undefined {
  if (update.title && !/^\d+\s+todos$/.test(update.title)) return update.title
  const input = update.input ?? {}
  if (typeof input.pattern === "string") return input.pattern
  if (typeof input.command === "string") return input.command
  if (typeof input.url === "string") return input.url
  if (typeof input.description === "string") return input.description
  if (typeof input.path === "string") return input.path
  return update.tool
}

function pickPath(update: ToolUpdate): string | undefined {
  if (typeof update.input?.filePath === "string") return update.input.filePath
  if (isFileTool(update.tool) && typeof update.input?.path === "string") return update.input.path
  if (isFileTool(update.tool) && update.title) return update.title
  return undefined
}

type ChangeKind = "created" | "updated" | "deleted" | "moved"

function changedFiles(updates: ToolUpdate[]) {
  return updates.flatMap((update): Array<{ path: string; kind: ChangeKind }> => {
    if (update.tool === "write") {
      const path = pickPath(update)
      if (!path) return []
      return [{ path, kind: update.metadata?.exists === false ? "created" : "updated" }]
    }
    if (update.tool === "edit") {
      const path = pickPath(update)
      if (!path) return []
      return [{ path, kind: update.input?.oldString === "" ? "created" : "updated" }]
    }
    if (update.tool !== "apply_patch") return []
    return patchFiles(update).map((file) => ({ path: file.path, kind: file.kind }))
  })
}

function patchFiles(update: ToolUpdate): Array<{ path: string; kind: ChangeKind; additions?: number; deletions?: number }> {
  const files = Array.isArray(update.metadata?.files) ? update.metadata.files : undefined
  if (files) {
    return files.flatMap((item) => {
      if (!isRecord(item) || typeof item.relativePath !== "string") return []
      return [{
        path: item.relativePath,
        kind: patchKind(item.type),
        additions: typeof item.additions === "number" ? item.additions : undefined,
        deletions: typeof item.deletions === "number" ? item.deletions : undefined,
      }]
    })
  }
  return [...(update.output ?? "").matchAll(/^[AMD]\s+(.+)$/gm)].map((match) => ({
    path: match[1] ?? "file",
    kind: match[0].startsWith("A ") ? "created" : match[0].startsWith("D ") ? "deleted" : "updated",
  }))
}

function patchKind(value: unknown): ChangeKind {
  if (value === "add") return "created"
  if (value === "delete") return "deleted"
  if (value === "move") return "moved"
  return "updated"
}

function kindLabel(kind: ChangeKind) {
  if (kind === "created") return "Created"
  if (kind === "deleted") return "Deleted"
  if (kind === "moved") return "Moved"
  return "Updated"
}

function editKind(update: ToolUpdate) {
  return update.input?.oldString === "" ? "Created" : "Updated"
}

function writeKind(update: ToolUpdate) {
  return update.metadata?.exists === false ? "Created" : "Updated"
}

function writeMeta(update: ToolUpdate) {
  if (typeof update.input?.content !== "string") return undefined
  const lines = update.input.content.split("\n").length
  return `${lines} ${plural(lines, "line")}`
}

function diffStat(update: ToolUpdate) {
  const filediff = isRecord(update.metadata?.filediff) ? update.metadata.filediff : undefined
  const additions = typeof filediff?.additions === "number" ? filediff.additions : undefined
  const deletions = typeof filediff?.deletions === "number" ? filediff.deletions : undefined
  if (additions === undefined && deletions === undefined) return undefined
  return compact([additions ? `+${additions}` : undefined, deletions ? `-${deletions}` : undefined]).join(" ")
}

function patchTarget(update: ToolUpdate) {
  const files = patchFiles(update)
  if (files.length === 1) return basename(files[0]!.path)
  if (files.length > 1) return `${files.length} ${plural(files.length, "file")}`
  return "patch"
}

function patchMeta(update: ToolUpdate) {
  const totals = patchFiles(update).reduce(
    (acc, file) => ({
      additions: acc.additions + (file.additions ?? 0),
      deletions: acc.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  )
  return compact([totals.additions ? `+${totals.additions}` : undefined, totals.deletions ? `-${totals.deletions}` : undefined]).join(" ") || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function compact<T>(items: Array<T | undefined>) {
  return items.filter((item): item is T => item !== undefined)
}

function lineRange(update: ToolUpdate): string | undefined {
  const matches = [...(update.output ?? "").matchAll(/(?:^|\n)(\d+): /g)]
  if (matches.length) {
    const start = matches[0]?.[1]
    const end = matches[matches.length - 1]?.[1]
    if (start && end) return start === end ? `L${start}` : `L${start}-${end}`
  }
  const offset = typeof update.input?.offset === "number" ? update.input.offset : undefined
  const limit = typeof update.input?.limit === "number" ? update.input.limit : undefined
  if (offset && limit) return `L${offset}-${offset + limit - 1}`
  if (offset) return `L${offset}`
  return undefined
}

function basename(value?: string) {
  if (!value) return undefined
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

function isFileTool(tool: string) {
  return tool === "read" || tool === "edit" || tool === "write"
}

function previewsInReview(update: ToolUpdate) {
  return update.tool === "edit" || update.tool === "write"
}

function plural(count: number, noun: string) {
  if (count !== 1 && noun === "search") return "searches"
  return count === 1 ? noun : `${noun}s`
}

function pastTense(tool: string) {
  if (tool.endsWith("e")) return `${tool}d`
  return `${tool}ed`
}
