import * as vscode from "vscode"
import { isInsideRoot, relativeToRoot, type WorkspaceRoot } from "../workspace-root"
import { defaultIgnoreMatcher, IgnoreMatcher } from "./ignore"

export type ScanResult = {
  files: Array<{ relativePath: string; absolutePath: string; size: number }>
  skipped: number
}

export type ScanOptions = {
  includeGlobs: string[]
  excludeGlobs: string[]
  maxFiles: number
  maxFileBytes: number
}

/**
 * Walk the workspace via `vscode.workspace.findFiles` and filter the result
 * through the ignore matcher (gitignore-style). Files larger than
 * `maxFileBytes` are dropped — the chunker never sees them. The scanner is
 * the only place that touches the disk; chunking + embedding happen on the
 * results.
 */
export async function scanWorkspace(
  workspace: WorkspaceRoot,
  options: ScanOptions,
): Promise<ScanResult> {
  const includeGlob = `{${options.includeGlobs.join(",")}}`
  const excludeGlob = `{${options.excludeGlobs.join(",")}}`
  const uris = await vscode.workspace.findFiles(includeGlob, excludeGlob, options.maxFiles)
  const ignore: IgnoreMatcher = defaultIgnoreMatcher()
  const files: ScanResult["files"] = []
  let skipped = 0
  for (const uri of uris) {
    if (uri.scheme !== "file") {
      skipped += 1
      continue
    }
    if (!isInsideRoot(workspace, uri.fsPath)) {
      skipped += 1
      continue
    }
    const rel = relativeToRoot(workspace, uri.fsPath)
    if (ignore.match(rel)) {
      skipped += 1
      continue
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri)
      if (stat.size > options.maxFileBytes) {
        skipped += 1
        continue
      }
      files.push({ relativePath: rel, absolutePath: uri.fsPath, size: stat.size })
    } catch {
      skipped += 1
    }
  }
  return { files, skipped }
}
