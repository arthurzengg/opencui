import type { ToolStatus, ToolUpdate } from "../protocol"
import { vscode } from "../vscode"

type FileAction = "read" | "created" | "updated" | "deleted" | "moved"

type FileOp = {
  path: string
  action: FileAction
  range?: string
  additions?: number
  deletions?: number
  status: ToolStatus
  errorText?: string
  reviewable: boolean
}

type OtherOp = {
  key: string
  action: string
  detail?: string
  title?: string
  status: ToolStatus
  errorText?: string
}

type PatchInput = { files: string[]; diff?: string }

export function ToolTrace({
  updates,
  patches = [],
  onReviewFile,
}: {
  updates: ToolUpdate[]
  patches?: PatchInput[]
  onReviewFile?: (path: string) => void
}) {
  const trace = buildTrace(updates, patches)
  if (!trace.edits.length && !trace.reads.length && !trace.others.length) return null

  return (
    <div className="trace">
      {trace.edits.length > 0 && (
        <div className="trace-edits">
          {trace.edits.map((op) => (
            <EditCard key={op.path} op={op} onReviewFile={onReviewFile} />
          ))}
        </div>
      )}
      {trace.reads.length > 0 && <ReadsLine reads={trace.reads} />}
      {trace.others.length > 0 && (
        <div className="trace-others">
          {trace.others.map((op) => (
            <OtherRow key={op.key} op={op} />
          ))}
        </div>
      )}
    </div>
  )
}

function EditCard({ op, onReviewFile }: { op: FileOp; onReviewFile?: (path: string) => void }) {
  const click = () => {
    if (onReviewFile && op.reviewable) onReviewFile(op.path)
    else vscode.post({ type: "openFile", path: op.path })
  }
  return (
    <button className={`edit-row status-${op.status} kind-${op.action}`} onClick={click} title={op.path}>
      <span className="edit-name">{basename(op.path)}</span>
      {typeof op.additions === "number" && op.additions > 0 && <span className="edit-add">+{op.additions}</span>}
      {typeof op.deletions === "number" && op.deletions > 0 && <span className="edit-del">−{op.deletions}</span>}
      {op.status === "running" && <span className="edit-running">running</span>}
      {op.errorText && <span className="edit-error">{op.errorText}</span>}
    </button>
  )
}

function ReadsLine({ reads }: { reads: FileOp[] }) {
  return (
    <div className="trace-reads">
      <span className="trace-reads-label">Read</span>
      <span className="trace-reads-count">{reads.length}</span>
      <div className="trace-reads-list">
        {reads.map((op, i) => (
          <button
            key={op.path}
            className="trace-read-chip"
            onClick={() => vscode.post({ type: "openFile", path: op.path })}
            title={op.range ? `${op.path} (${op.range})` : op.path}
          >
            <span className="trace-read-name">{basename(op.path)}</span>
            {op.range && <span className="trace-read-range">{op.range}</span>}
            {i < reads.length - 1 && <span className="trace-read-sep">,</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

function OtherRow({ op }: { op: OtherOp }) {
  return (
    <div className={`other-row status-${op.status}`} title={op.title}>
      <span className="other-action">{op.action}</span>
      {op.detail && <span className="other-detail">{op.detail}</span>}
      {op.status === "running" && <span className="other-meta">running</span>}
      {op.errorText && <span className="other-error">{op.errorText}</span>}
    </div>
  )
}

function buildTrace(updates: ToolUpdate[], patches: PatchInput[]) {
  const fileOps = new Map<string, FileOp>()
  const others: OtherOp[] = []

  for (const update of updates) {
    if (update.tool === "read") {
      const path = pickPath(update)
      if (!path) {
        others.push(genericOther(update))
        continue
      }
      const existing = fileOps.get(path)
      if (existing && existing.action !== "read") continue
      fileOps.set(path, {
        path,
        action: "read",
        range: lineRange(update) ?? existing?.range,
        status: mergeStatus(existing?.status, update.status),
        errorText: update.error ?? existing?.errorText,
        reviewable: false,
      })
      continue
    }
    if (update.tool === "edit") {
      const path = pickPath(update)
      if (!path) {
        others.push(genericOther(update))
        continue
      }
      const action: FileAction = update.input?.oldString === "" ? "created" : "updated"
      const stats = diffStats(update)
      mergeFileOp(fileOps, path, {
        action,
        additions: stats.additions,
        deletions: stats.deletions,
        status: update.status,
        errorText: update.error,
        reviewable: true,
      })
      continue
    }
    if (update.tool === "write") {
      const path = pickPath(update)
      if (!path) {
        others.push(genericOther(update))
        continue
      }
      const action: FileAction = update.metadata?.exists === false ? "created" : "updated"
      mergeFileOp(fileOps, path, {
        action,
        additions: writeLines(update),
        status: update.status,
        errorText: update.error,
        reviewable: true,
      })
      continue
    }
    if (update.tool === "apply_patch") {
      const files = patchFilesFromUpdate(update)
      if (!files.length) {
        others.push({
          key: update.callID,
          action: "Applied patch",
          status: update.status,
          errorText: update.error,
        })
        continue
      }
      for (const file of files) {
        mergeFileOp(fileOps, file.path, {
          action: file.kind,
          additions: file.additions,
          deletions: file.deletions,
          status: update.status,
          errorText: update.error,
          reviewable: true,
        })
      }
      continue
    }
    others.push(deriveOther(update))
  }

  for (const patch of patches) {
    for (const entry of patch.files) {
      const match = entry.match(/^([AMD])\s+(.+)$/)
      const path = (match?.[2] ?? entry).trim()
      if (!path) continue
      if (fileOps.has(path)) continue
      const code = match?.[1]
      const action: FileAction = code === "A" ? "created" : code === "D" ? "deleted" : "updated"
      fileOps.set(path, {
        path,
        action,
        status: "completed",
        reviewable: true,
      })
    }
  }

  const allOps = [...fileOps.values()]
  const edits = allOps.filter((op) => op.action !== "read")
  const reads = allOps.filter((op) => op.action === "read")
  return { edits, reads, others }
}

function mergeFileOp(map: Map<string, FileOp>, path: string, patch: Omit<FileOp, "path" | "range" | "reviewable"> & { reviewable: boolean }) {
  const existing = map.get(path)
  const additions = (existing?.additions ?? 0) + (patch.additions ?? 0)
  const deletions = (existing?.deletions ?? 0) + (patch.deletions ?? 0)
  const action = preferAction(existing?.action, patch.action)
  map.set(path, {
    path,
    action,
    additions: additions || undefined,
    deletions: deletions || undefined,
    status: mergeStatus(existing?.status, patch.status),
    errorText: patch.errorText ?? existing?.errorText,
    reviewable: patch.reviewable || (existing?.reviewable ?? false),
  })
}

function preferAction(existing: FileAction | undefined, next: FileAction): FileAction {
  if (!existing) return next
  if (existing === "read") return next
  if (next === "read") return existing
  if (existing === "created" || next === "created") return "created"
  if (existing === "deleted" || next === "deleted") return "deleted"
  return next
}

function mergeStatus(existing: ToolStatus | undefined, next: ToolStatus): ToolStatus {
  if (!existing) return next
  if (next === "error" || existing === "error") return "error"
  if (next === "running" || existing === "running") return "running"
  if (next === "pending" || existing === "pending") return "pending"
  return next
}

function deriveOther(update: ToolUpdate): OtherOp {
  if (update.tool === "grep") {
    return {
      key: update.callID,
      action: "Grepped",
      detail: stringInput(update, "pattern") ?? update.title,
      status: update.status,
      errorText: update.error,
    }
  }
  if (update.tool === "glob") {
    return {
      key: update.callID,
      action: "Searched",
      detail: stringInput(update, "pattern") ?? update.title,
      status: update.status,
      errorText: update.error,
    }
  }
  if (update.tool === "bash") {
    return {
      key: update.callID,
      action: "Ran",
      detail: stringInput(update, "command") ?? update.title,
      status: update.status,
      errorText: update.error,
    }
  }
  if (update.tool === "webfetch") {
    return {
      key: update.callID,
      action: "Fetched",
      detail: stringInput(update, "url") ?? update.title,
      status: update.status,
      errorText: update.error,
    }
  }
  if (update.tool === "todowrite") {
    return {
      key: update.callID,
      action: "Updated todos",
      status: update.status,
      errorText: update.error,
    }
  }
  if (update.tool === "task") {
    return {
      key: update.callID,
      action: "Investigated",
      detail: stringInput(update, "description") ?? update.title,
      status: update.status,
      errorText: update.error,
    }
  }
  return genericOther(update)
}

function genericOther(update: ToolUpdate): OtherOp {
  return {
    key: update.callID,
    action: pastTense(update.tool),
    detail: update.title ?? stringInput(update, "description"),
    status: update.status,
    errorText: update.error,
  }
}

function stringInput(update: ToolUpdate, key: string): string | undefined {
  const value = update.input?.[key]
  return typeof value === "string" ? value : undefined
}

function pickPath(update: ToolUpdate): string | undefined {
  if (typeof update.input?.filePath === "string") return update.input.filePath
  if (isFileTool(update.tool) && typeof update.input?.path === "string") return update.input.path
  if (isFileTool(update.tool) && update.title) return update.title
  return undefined
}

function patchFilesFromUpdate(update: ToolUpdate): Array<{ path: string; kind: FileAction; additions?: number; deletions?: number }> {
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

function patchKind(value: unknown): FileAction {
  if (value === "add") return "created"
  if (value === "delete") return "deleted"
  if (value === "move") return "moved"
  return "updated"
}

function diffStats(update: ToolUpdate): { additions?: number; deletions?: number } {
  const filediff = isRecord(update.metadata?.filediff) ? update.metadata.filediff : undefined
  return {
    additions: typeof filediff?.additions === "number" ? filediff.additions : undefined,
    deletions: typeof filediff?.deletions === "number" ? filediff.deletions : undefined,
  }
}

function writeLines(update: ToolUpdate): number | undefined {
  if (typeof update.input?.content !== "string") return undefined
  return update.input.content.split("\n").length
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isFileTool(tool: string) {
  return tool === "read" || tool === "edit" || tool === "write"
}

function basename(value: string) {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

function pastTense(tool: string) {
  if (tool.endsWith("e")) return `${tool}d`
  return `${tool}ed`
}

export function toolHeadline(updates: ToolUpdate[]) {
  const trace = buildTrace(updates, [])
  if (trace.edits.length === 1) return `${kindWord(trace.edits[0]!.action)} ${basename(trace.edits[0]!.path)}`
  if (trace.edits.length > 1) {
    const created = trace.edits.filter((op) => op.action === "created").length
    const deleted = trace.edits.filter((op) => op.action === "deleted").length
    if (created && created === trace.edits.length) return `Created ${created} files`
    if (deleted && deleted === trace.edits.length) return `Deleted ${deleted} files`
    return `Changed ${trace.edits.length} files`
  }
  if (trace.reads.length && trace.others.length) return `Explored ${trace.reads.length} files, ${trace.others.length} ops`
  if (trace.reads.length) return `Read ${trace.reads.length} ${trace.reads.length === 1 ? "file" : "files"}`
  if (trace.others.length) return `Used ${trace.others.length} ${trace.others.length === 1 ? "tool" : "tools"}`
  return `Used ${updates.length} ${updates.length === 1 ? "tool" : "tools"}`
}

function kindWord(action: FileAction): string {
  if (action === "created") return "Created"
  if (action === "deleted") return "Deleted"
  if (action === "moved") return "Moved"
  if (action === "read") return "Read"
  return "Updated"
}
