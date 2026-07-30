import * as path from "path"

export function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "")
}

export function samePath(left: string, right?: string) {
  if (!right) return false
  return normalizePath(left) === normalizePath(right)
}

/**
 * If `relPath` starts with the workspace folder's basename (e.g. opencode
 * resolved the path including the worktree directory), strip that prefix so
 * the result is relative to the workspace root. Returns undefined when the
 * prefix doesn't match — caller should fall back to the original path.
 */
export function stripWorkspaceFolderPrefix(workspacePath: string, relPath: string): string | undefined {
  const segments = normalizePath(relPath).split("/").filter(Boolean)
  if (segments.length < 2) return undefined
  if (segments[0].toLowerCase() !== path.basename(workspacePath).toLowerCase()) return undefined
  return segments.slice(1).join("/")
}

/**
 * Make `p` relative to `cwd`. For absolute paths uses node's `path.relative`,
 * but only if the result doesn't escape `cwd` (no leading `..`); otherwise
 * returns the original. For relative paths, strips a leading workspace-folder
 * basename if present so opencode's worktree-rooted paths line up with our
 * VSCode workspace root.
 */
export function relativeToCwd(cwd: string, p: string): string {
  if (!p) return p
  if (!path.isAbsolute(p)) return stripWorkspaceFolderPrefix(cwd, p) ?? p
  const rel = path.relative(cwd, p)
  return rel && !rel.startsWith("..") ? rel : p
}

export function unique(items: string[]) {
  return [...new Set(items)]
}
