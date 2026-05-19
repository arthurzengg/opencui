import * as vscode from "vscode"
import * as path from "path"

/**
 * Resolved workspace root used for opencode server `cwd`, SDK `directory`,
 * automatic context collection, and prompt grounding. Phases 2+ of the
 * workspace-context plan key off this shape — see
 * docs/workspace-context-and-indexing.md.
 */
export type WorkspaceRoot = {
  uri: vscode.Uri
  fsPath: string
  name: string
  /** Position in `vscode.workspace.workspaceFolders` — preserved for multi-root UIs. */
  index: number
  /** True when this is the first workspace folder (no active-editor signal needed). */
  isDefault: boolean
}

export function getWorkspaceRoots(): WorkspaceRoot[] {
  const folders = vscode.workspace.workspaceFolders ?? []
  return folders.map((folder, index) => ({
    uri: folder.uri,
    fsPath: folder.uri.fsPath,
    name: folder.name,
    index,
    isDefault: index === 0,
  }))
}

/**
 * The root that should drive this turn. Prefers the workspace folder that
 * contains the active editor — that's the project the user is "in". Falls
 * back to the first folder when no editor is focused on a workspace file.
 * Returns undefined when there are no workspace folders at all, meaning
 * callers should run in no-workspace mode (no automatic context, prompts
 * carry no workspace declaration).
 */
export function primaryWorkspaceRoot(): WorkspaceRoot | undefined {
  const active = vscode.window.activeTextEditor?.document.uri
  const fromActive = active ? workspaceRootForUri(active) : undefined
  if (fromActive) return fromActive
  return getWorkspaceRoots()[0]
}

export function workspaceRootForUri(uri: vscode.Uri | undefined): WorkspaceRoot | undefined {
  if (!uri || uri.scheme !== "file") return undefined
  return workspaceRootForPath(uri.fsPath)
}

export function workspaceRootForPath(filePath: string | undefined): WorkspaceRoot | undefined {
  if (!filePath) return undefined
  const roots = getWorkspaceRoots()
  // Prefer the longest matching root so a nested workspace folder wins over
  // an outer one (rare but possible: a monorepo with both `repo` and
  // `repo/packages/foo` opened as folders).
  let best: WorkspaceRoot | undefined
  for (const root of roots) {
    if (!isInsideRoot(root, filePath)) continue
    if (!best || root.fsPath.length > best.fsPath.length) best = root
  }
  return best
}

export function isInsideWorkspace(filePath: string): boolean {
  return !!workspaceRootForPath(filePath)
}

export function isInsideRoot(root: WorkspaceRoot, filePath: string): boolean {
  if (!filePath) return false
  const rel = path.relative(root.fsPath, filePath)
  // `path.relative` returns "" for the root itself, a `..`-prefixed string
  // for paths above the root, and an absolute path on Windows when the two
  // sides live on different drives.
  if (rel === "") return true
  if (rel.startsWith("..")) return false
  if (path.isAbsolute(rel)) return false
  return true
}

export function relativeToRoot(root: WorkspaceRoot, filePath: string): string {
  const rel = path.relative(root.fsPath, filePath)
  // Forward slashes for prompt and protocol consistency; the host's `path`
  // module returns backslashes on Windows otherwise.
  return rel.replace(/\\/g, "/")
}
