import * as vscode from "vscode"
import * as path from "path"
import type { DirEntry, FileSearchHit } from "./protocol"

const MAX_FILES = 5000
const MAX_HITS = 30

let cache: FileSearchHit[] | undefined
let cacheLoadedAt = 0
const CACHE_TTL_MS = 30_000

function invalidateCache(): void {
  cache = undefined
  cacheLoadedAt = 0
}

/**
 * Wire cache invalidation to the workspace lifecycle. The 30s TTL alone lets
 * the @-picker show files that were just deleted (still listed, then fail to
 * read) and miss freshly created ones for up to 30s. A FileSystemWatcher on
 * create/delete and a workspace-folder-change listener drop the stale index
 * immediately. Registered once from activate(); disposables go on the context.
 */
export function initFileSearch(context: vscode.ExtensionContext): void {
  const watcher = vscode.workspace.createFileSystemWatcher("**/*")
  watcher.onDidCreate(invalidateCache)
  watcher.onDidDelete(invalidateCache)
  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeWorkspaceFolders(invalidateCache),
  )
}

async function loadFiles(): Promise<FileSearchHit[]> {
  const now = Date.now()
  if (cache && now - cacheLoadedAt < CACHE_TTL_MS) return cache
  const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,build,out,coverage,.next,.turbo,.cache}/**", MAX_FILES)
  cache = uris.map((uri) => ({
    path: vscode.workspace.asRelativePath(uri),
    name: path.basename(uri.fsPath),
  }))
  cacheLoadedAt = now
  return cache
}

export async function searchWorkspaceFiles(query: string): Promise<FileSearchHit[]> {
  const all = await loadFiles()
  const recent = getRecentlyOpenedPaths()
  return rankHits(all, query, recent).slice(0, MAX_HITS)
}

/**
 * List the immediate children (subfolders + files) of a workspace-relative
 * folder for the @-picker's drill-down browser. Derived from the same cached
 * file index the search uses, so the ignore-globs and 30s cache are shared.
 */
export async function listWorkspaceDir(dir: string): Promise<DirEntry[]> {
  return dirEntriesFrom(await loadFiles(), dir)
}

/**
 * Pure derivation of a folder's immediate children from the flat file index.
 * `dir` is "" for the workspace root; a trailing slash is tolerated. Folders
 * come first (alphabetical), then files (alphabetical). Folders are inferred
 * from file paths, so one that holds only ignored files never appears — there
 * would be nothing to drill into anyway.
 */
export function dirEntriesFrom(files: FileSearchHit[], dir: string): DirEntry[] {
  const prefix = dir ? dir.replace(/\/+$/, "") + "/" : ""
  const folders = new Set<string>()
  const fileEntries: DirEntry[] = []
  for (const hit of files) {
    if (prefix && !hit.path.startsWith(prefix)) continue
    const rest = hit.path.slice(prefix.length)
    const slash = rest.indexOf("/")
    if (slash === -1) {
      fileEntries.push({ name: rest, path: hit.path, kind: "file" })
    } else {
      folders.add(rest.slice(0, slash))
    }
  }
  const folderEntries: DirEntry[] = [...folders]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, path: prefix + name, kind: "folder" }))
  fileEntries.sort((a, b) => a.name.localeCompare(b.name))
  return [...folderEntries, ...fileEntries]
}

/**
 * Workspace-relative paths currently open in VS Code tabs, in their natural
 * tab order. The active editor's tab usually ends up first; pinned tabs and
 * recently focused ones cluster near the front. Used to boost the @ picker
 * so the file you're actually looking at is the most-likely first hit.
 */
export function getRecentlyOpenedPaths(): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const active = vscode.window.activeTextEditor?.document.uri
  const pushUri = (uri: vscode.Uri | undefined) => {
    if (!uri || uri.scheme !== "file") return
    const rel = vscode.workspace.asRelativePath(uri)
    if (seen.has(rel)) return
    seen.add(rel)
    out.push(rel)
  }
  // Active editor first — that's the file the user is "in".
  pushUri(active)
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input
      if (input && typeof input === "object" && "uri" in input) {
        pushUri((input as { uri: vscode.Uri }).uri)
      }
    }
  }
  return out
}

/**
 * Rank `entries` against `query`. Empty query returns recent files first
 * (then the rest in original order). Non-empty query orders by:
 *   1. Exact basename match
 *   2. Basename prefix match
 *   3. Basename substring match
 *   4. Path substring match
 * Within each tier, recently-opened files come first, then shorter paths.
 */
export function rankHits(
  entries: FileSearchHit[],
  query: string,
  recentPaths: string[] = [],
): FileSearchHit[] {
  const recentRank = new Map<string, number>()
  recentPaths.forEach((path, i) => {
    if (!recentRank.has(path)) recentRank.set(path, i)
  })

  const q = query.toLowerCase().trim()
  if (!q) {
    // Empty query: surface recently-opened files at the top, then the rest in
    // their natural ordering (workspace listing order).
    const inRecent: FileSearchHit[] = []
    const others: FileSearchHit[] = []
    for (const hit of entries) {
      if (recentRank.has(hit.path)) inRecent.push(hit)
      else others.push(hit)
    }
    inRecent.sort((a, b) => (recentRank.get(a.path) ?? 0) - (recentRank.get(b.path) ?? 0))
    return [...inRecent, ...others].slice(0, MAX_HITS)
  }

  const scored: Array<{ hit: FileSearchHit; score: number; recent: number; len: number }> = []
  for (const hit of entries) {
    const name = hit.name.toLowerCase()
    const fullPath = hit.path.toLowerCase()
    let score: number
    if (name === q) score = 0
    else if (name.startsWith(q)) score = 1
    else if (name.includes(q)) score = 2
    else if (fullPath.includes(q)) score = 3
    else continue
    // recent === Infinity means "not in tabs". A lower number = more recent.
    const recent = recentRank.get(hit.path) ?? Number.POSITIVE_INFINITY
    scored.push({ hit, score, recent, len: hit.path.length })
  }
  scored.sort((a, b) => a.score - b.score || a.recent - b.recent || a.len - b.len)
  return scored.map((s) => s.hit)
}
