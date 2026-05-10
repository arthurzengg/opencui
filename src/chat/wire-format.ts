import * as path from "path"
import type { ToolUpdate } from "./stream"
import type { ToolUpdate as WireToolUpdate } from "../protocol"
import { isRecord, relativeToCwd } from "./paths"

/**
 * Normalize an SDK ToolUpdate into the wire format that flows to the webview.
 * The main job is to rewrite paths so they're relative to the user's VSCode
 * workspace folder rather than opencode's internal directory (which can differ
 * when opencode runs against a worktree root).
 */
export function toWire(update: ToolUpdate, cwd: string): WireToolUpdate {
  const input = update.input ? { ...update.input } : undefined
  const metadata = update.metadata ? normalizeWireMetadata(update.metadata, cwd) : undefined
  if (input) {
    // Prefer the absolute filepath opencode resolved (in metadata) over the
    // raw model input. The raw input may be relative to opencode's internal
    // directory (e.g., the git worktree root) which differs from our VSCode
    // workspace folder, and a relative path here would be joined against the
    // wrong base when we open or stat the file.
    const resolved = pickResolvedPath(metadata)
    if (resolved && path.isAbsolute(resolved)) {
      input.filePath = relativeToCwd(cwd, resolved)
    } else if (typeof input.filePath === "string") {
      input.filePath = relativeToCwd(cwd, input.filePath)
    }
    if (typeof input.path === "string") input.path = relativeToCwd(cwd, input.path)
  }
  return {
    callID: update.callID,
    tool: update.tool,
    status: update.status,
    title: update.title,
    input,
    metadata,
    output: update.output,
    error: update.error,
  }
}

function normalizeWireMetadata(metadata: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const next = { ...metadata }
  if (typeof next.filepath === "string" && !path.isAbsolute(next.filepath)) {
    next.filepath = relativeToCwd(cwd, next.filepath)
  }
  if (isRecord(next.filediff)) {
    const filediff = { ...next.filediff }
    if (typeof filediff.file === "string" && !path.isAbsolute(filediff.file)) {
      filediff.file = relativeToCwd(cwd, filediff.file)
    }
    next.filediff = filediff
  }
  if (Array.isArray(next.files)) {
    next.files = next.files.map((file) => {
      if (!isRecord(file) || typeof file.relativePath !== "string") return file
      return { ...file, relativePath: relativeToCwd(cwd, file.relativePath) }
    })
  }
  return next
}

function pickResolvedPath(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined
  if (typeof metadata.filepath === "string") return metadata.filepath
  const filediff = metadata.filediff
  if (isRecord(filediff) && typeof filediff.file === "string") return filediff.file
  return undefined
}
